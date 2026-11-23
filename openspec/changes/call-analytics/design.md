## Context

**Журнал сейчас** (`src-tauri/migrations/0010_context_findings.sql`, `storage/call_state.rs`):
- `agent_calls` привязан к записи (`recording_id NOT NULL`). В нём есть `kind IN ('fastLoop','topicCheck','slowLoop')`, исход, токены, `cost_usd`, `utilization`, `rejected` (JSON) и `error`.
- Строка пишется **после** `apply_patch_at` в одном savepoint (`fast_loop/scheduler.rs:983-1012`). Поэтому id вызова неизвестен, пока применяются операции, а `AppliedPatch { topic_ids, question_ids }` выбрасывается.
- Промпт не сохраняется:
  - стабильный префикс пишется в `<agent>/<recording>.prompt.md` (`assembly::write_prompt`) один раз на запись, сообщение каждый раз собирается в `assembly::user_message`;
  - у медленного контура префикс `<recording>.slow.md`, у проверки темы `topic-check.md`;
  - итоги, предложения и бриф пишут `PromptFile`, который удаляется на `Drop`, а токены уходят в `eprintln!` (`summary/run.rs:566`, `projects/brief/run.rs:409`).
- Причины отказа уже машиночитаемы:
  - `validate::RejectReason` (18 вариантов, `tag = "reason"`);
  - `slow_loop::validate::SlowRejectReason`;
  - у проверки темы причина — свободная строка (`scheduler.rs:1250`).
- Триггер вызова неизвестен: `speech/service.rs:232` передаёт в `fast_loop.phrase` только канал, хотя у `TranscriptPhrase` есть `id`.
- Действия менеджера (`call_state::act`, `QuestionAction = Pin | Unpin | Hide | Asked | Restore`) и `recompute` (`shown_at`, `requeued_at`) только перезаписывают текущее состояние. У находки есть `hidden_at`, `evicted_at` и `agent_call_id`.
- Уточнённая расшифровка заменяется целиком с новыми id (`transcript::replace_refined`). Основания и окна контуров всегда указывают на живые (`live`) сегменты.
- Сеть: `reqwest 0.13` (rustls) уже в зависимостях; WebSocket-крейтов и `tokio/net` нет. Релизную сборку отличают по `cfg!(debug_assertions)` (как `updates.rs:32`).
- Репозиторий — один пакет без `workspaces`. Фронтенд Grill — статический экспорт Next.js 16. Дизайн-система лежит в `src/components/ui`.

Мотивация — в proposal.md, требования — в specs.

## Goals / Non-Goals

**Goals:**
- Связи «реплика → вызов → промпт → ответ → операция → вопрос → действие» хранятся в Grill явно, а не восстанавливаются эвристикой на сервере.
- Журнал и отправка не меняют промпт, задержку вызовов и поведение окон.
- Один источник правды для формата событий — Rust. Сервер и веб не могут молча разойтись с ним.
- Сервер можно пересобрать из лога событий при смене своей схемы.

**Non-Goals:**
- Горизонтальное масштабирование сервера: один процесс, одна база.
- Сжатие и шифрование трафика сверх того, что даёт сеть.
- Ретроспективная выгрузка старых звонков.

## Decisions

### 1. Id вызова до применения патча

- В начале `run_call`, `run_topic_check`, вызова медленного контура, итогов, предложений и брифа создаётся `call_id = new_id()`.
- `insert_agent_call_at` получает его во входе (`AgentCallInput.id`), а не генерирует сам.
- Операции, вопросы и события ссылаются на вызов в том же savepoint, где применяется патч. Строка `agent_calls` по-прежнему вставляется в конце того же savepoint, и внешние ключи соблюдаются.

Альтернатива — вставлять строку вызова до применения и потом обновлять. Отвергнута: два места записи, а у отменённого вызова остаётся строка без исхода.

### 2. Схема журнала в Grill (миграция `0013_analytics_journal.sql`)

**`agent_calls` перестраивается** (как в 0010, CHECK в SQLite не меняется на месте):
- `recording_id` становится NULL-able. Добавляются:
  - `call_id` (итоги и предложения);
  - `project_id` (бриф);
  - `model`, `effort`;
  - `trigger_reason` (`firstPhrase | turnEnd | interval | retry | manualRetry | haltReset | topicChanged`, NULL для итогов и брифа; `trigger` — ключевое слово SQLite);
  - `trigger_segment_id`;
  - `window_segments` (JSON массив id сегментов; `window` — ключевое слово SQLite);
  - `findings_in_prompt` (JSON массив id находок, ушедших в промпт, в порядке `D1…Dn`);
  - `queries` (JSON, медленный контур);
  - `raw_reply` (TEXT, событие `result` CLI целиком);
  - `reply` (JSON, разобранный патч или ответ).
- `kind` дополняется `summary`, `proposals`, `brief`.
- CHECK: ровно одно из `recording_id`, `call_id`, `project_id` задаёт владельца по виду.
- `rejected` остаётся для `grill-eval` и совместимости.

**Новые таблицы:**

| Таблица | Поля и смысл |
|---|---|
| `prompt_parts` | `hash` (SHA-256 текста, PK), `text` (NULL после очистки по `transcriptRetention`), `bytes`, `created_at`. Части промптов, каждый текст один раз |
| `agent_call_parts` | `(agent_call_id, ord)` PK, `label` (`file`, `mode`, `topics`, `card`, `questions`, `findings`, `quiet`, `transcript`, `candidates`, `output`, …), `hash` → `prompt_parts` |
| `agent_call_ops` | `(agent_call_id, idx)` PK, `op` (вид операции), `body` (JSON операции, как её вернул агент), `applied` (0/1), `reason` (JSON `RejectReason` или NULL), `subject_kind` (`question`, `topic`, `card`, `finding`), `subject_id`. Отсюда происхождение: вопрос создан вызовом X — это применённая операция `addQuestion` с `subject_id` = вопрос |
| `slow_loop_candidates` | `(agent_call_id, label)` PK (`C1…`), `rank`, `chunk_key`, `source_id`, `source_kind`, `source_name`, `source_url`, `heading_path`, `text` |
| `question_events` | `id`, `question_id`, `recording_id`, `kind` (`created`, `shown`, `requeued`, `unshown`, `pinned`, `unpinned`, `hidden`, `restored`, `asked`, `answered`), `agent_call_id` (NULL для действий менеджера и `recompute`), `at` |
| `finding_events` | `id`, `finding_id`, `kind` (`shown`, `hidden`, `evicted`), `at` |
| `analytics_outbox` | см. решение 5 |

Ссылки на `agent_calls` из новых таблиц — `DEFERRABLE INITIALLY DEFERRED`: операции, части и события пишутся раньше строки вызова в том же savepoint (решение 1) и проверяются при коммите.

**Почему происхождение через `agent_call_ops`, а не колонки `created_by_call` в `questions`, `topics` и `task_cards`.** Операция уже несёт связь «вызов → сущность» для всех видов, включая факты карточки: у них нет своих строк, они лежат в JSON `task_cards.fields`. Колонки в трёх таблицах дублировали бы это и требовали бы ещё трёх перестроек. Вопрос «кто создал вопрос Q» — это `SELECT … FROM agent_call_ops WHERE subject_id = Q AND op = 'addQuestion' AND applied = 1`, с индексом по `subject_id`.

**Части промпта.**
- Сборка контуров начинает возвращать разделы `Vec<(label, String)>`. Строка, которая уходит в CLI, — их склейка тем же разделителем, что сейчас. Тест снимка `assembly` подтверждает, что байты не изменились (spec «Журнал не меняет поведение звонка»).
- Префикс записи хешируется один раз, при `prepare()`.
- Окно расшифровки хранится как текст части `transcript`, а не как ссылки на сегменты: так в журнале ровно то, что видел агент, даже если сегменты потом заменят или удалят. Список id идёт отдельно в `window`.

**Локальное хранение.** Тексты журнала в Grill — `prompt_parts`, `raw_reply`, `slow_loop_candidates.text` — содержат расшифровку. Поэтому они чистятся вместе с расшифровкой по `transcriptRetention` (`storage/retention.rs`): тексты стираются, метаданные и связи остаются. Части, на которые ещё ссылаются вызовы с живой расшифровкой, остаются. Сервер это не трогает (spec `analytics-server`, «Бессрочное хранение»).

### 3. Триггер и окно

- `speech/service.rs` передаёт в `fast_loop.phrase` и `slow_loop.phrase` ещё и id фразы.
- Планировщик быстрого контура хранит `last_client_segment` и причину ближайшего запуска. Причина ставится там, где сейчас считается `due_at`, и в обработчиках `Retry`, сброса остановки и таймера повтора.
- `run_call` получает `(trigger, trigger_segment_id)` и записывает их вместе с `assembled.context.segments` как `window`.
- Медленный контур пишет `topicChanged` или `interval` и последнюю фразу клиента.

### 4. Где пишутся события вопросов и находок

Один модуль `storage::journal` с функциями, которые принимают `&Transaction`:
- `question_event(tx, question_id, kind, agent_call_id, at)`;
- `finding_event(tx, …)`;
- `call_ops(tx, call_id, ops)`;
- `prompt(tx, call_id, parts)`.

Их вызывают:
- `add_question` → `created`;
- `mark_answered` → `answered` с вызовом;
- `act` → `pinned` / `unpinned` / `hidden` / `restored` / `asked`;
- `recompute` → `shown` / `requeued` / `unshown`, по разнице `shown_at` до и после;
- `context_findings::insert_at` → `shown`;
- `context_findings::hide` → `hidden`;
- вытеснение → `evicted`.

Все они пишут и в свою таблицу, и в очередь отправки (решение 5) в той же транзакции. Ошибка журнала внутри savepoint откатывает весь savepoint, как любая ошибка хранилища сейчас: вызов записывается с исходом `error` (`scheduler.rs:1015`). Отдельно «проглатывать» ошибки журнала не стоит: это та же база и та же транзакция. Требование «ошибка журнала не отменяет патч» выполняется так: журнал не делает ничего, что может упасть, кроме записи в ту же SQLite.

### 5. Очередь отправки и контракт событий

**Таблица.** `analytics_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE (UUID v7), kind TEXT, v INTEGER, body TEXT (JSON), bytes INTEGER, created_at INTEGER)`.
- `storage::analytics::enqueue(tx, event)` — no-op, если отправка выключена (решение 7). Тогда очередь не растёт у разработчиков и в тестах.
- В тестах есть режим «включено без сети», чтобы проверять события.

**События — снимки фактов, а не дельты.** Каждое событие несёт полное состояние своей сущности на момент записи (`question` со статусом, `agentCall` со всеми полями и т. д.). Так повтор, пропуск и смена порядка не ломают сервер: у сущности побеждает снимок с самым поздним `at`, а потерянный промежуточный снимок не важен. Исключения, где важна каждая запись: `questionEvent`, `findingEvent` и `agentCallOp`. Это неизменяемые факты, каждый со своим id.

**Виды событий** (`v = 1`):
- `project { localId, name }` — при создании и переименовании;
- `call { id, projectLocalId?, title, status, startedAt, endedAt }`;
- `recording { id, callId?, status, startedAt, endedAt }`;
- `segment { id, recordingId, pass: live, channel, startMs, endMs, text }`;
- `refinedTranscript { recordingId, segments[] }` — целиком, так как `replace_refined` меняет id;
- `topic`, `card { id, topicId, fields }`, `question` (снимок строки с `evidence`, `answerEvidence`);
- `finding` (снимок `context_findings`), `findingEvent`;
- `promptPart { hash, text }` — только когда `INSERT OR IGNORE` в `prompt_parts` действительно вставил строку;
- `agentCall` (строка `agent_calls` со всеми полями, `parts: [{label, hash}]`, кандидаты), `agentCallOp`;
- `questionEvent`.

**Конверт:** `{ id, v, kind, at, body }`.
- `at` — время на машине менеджера, в мс.
- Звонок и проект указываются в `body` id-ссылками. Сервер привязывает сущность к проекту через цепочку `recording → call → project.localId`.

**Какие звонки отправляются.**
- `analytics_meta.enabled_since` ставится при первом запуске версии с аналитикой.
- События сущностей звонка ставятся в очередь, только если у звонка или записи `created_at >= enabled_since`.
- Проекты отправляются всегда: проект без звонков на сервере просто пуст.

**Контракт — из Rust.**
- Типы событий описаны в `src-tauri/src/analytics/contract.rs` с `serde` и `specta::Type`.
- `cargo test` экспортирует их в `analytics/contract/src/generated.ts`, как сейчас `bindings.ts`, и пишет по одному образцу каждого события в `analytics/contract/fixtures/*.json`.
- Пакет `@grill/analytics-contract` содержит Effect `Schema` событий, написанные руками. В нём есть:
  - проверка на уровне типов, что `Schema.Type<…>` и сгенерированный тип совпадают в обе стороны;
  - Vitest-тест, который декодирует все образцы.
- CI падает, если `generated.ts` или образцы устарели (`git diff --exit-code`), так же как сейчас на `bindings.ts`.

Альтернатива — JSON Schema через `schemars` и генерация Effect Schema из неё. Отвергнута: ещё одна зависимость и генератор ради десятка типов, а проверка типов и образцы ловят то же расхождение.

### 6. Отправитель: HTTP-пакеты, а не WebSocket

`analytics::Sender` — одна tokio-задача приложения:
- Просыпается по `Notify` после коммита транзакции, в которой было `enqueue`, и по таймеру раз в 5 с.
- Читает из очереди до 500 событий или 1 МБ по `seq` и делает `POST {url}/api/ingest` с JSON-телом.
- Ответ — `{ accepted: [id…] }`. Принятые события удаляются из очереди.
- Ошибка сети или 5xx — пауза 1 → 2 → 4 … 60 с со случайным разбросом. 4xx на весь пакет записывается в лог. Пакет не удаляется, пауза максимальная: на сервере ошибка, и терять события нельзя.
- Отдельные неверные события сервер подтверждает сам (spec `analytics-server`, «Версии контракта»), поэтому очередь не застревает.
- Перед чтением проверяется размер очереди: больше 500 МБ — удаляются самые старые, и в лог пишется число удалённых.
- Работает на своём соединении SQLite, а не через `Storage::write`, поэтому не держит блокировку записи дольше одной выборки или удаления.
- При выходе из приложения задача прерывается без ожидания. Очередь остаётся в базе.

Почему HTTP, а не WebSocket, как обсуждалось в грилинге:
- `reqwest` с rustls уже в сборке и проверен на macOS и Windows, а WebSocket требует `tokio-tungstenite`, `tokio/net` и свою логику переподключения;
- подтверждение пакета — это естественный ответ на запрос, без своего протокола подтверждений поверх сокета;
- keep-alive держит соединение, и задержка «записано → на сервере» — одна поездка до сервера, это укладывается в 2 с из spec.

Для пользователя разницы нет: данные уходят потоком, а не после звонка.

### 7. Включение

- Адрес: `const BAKED: Option<&str> = option_env!("GRILL_ANALYTICS_URL")`. Он задаётся в CI при релизной сборке.
- Релизная сборка (`!cfg!(debug_assertions)`) берёт `BAKED`. Debug-сборка — только `std::env::var("GRILL_ANALYTICS_URL")` при запуске.
- Нет адреса — отправка выключена: `enqueue` ничего не пишет, `Sender` не стартует.
- Браузерный демо-режим не трогает Rust вовсе. `grill-eval` собирается с `feature = "eval"`, и там отправка выключена явно.

### 8. Сервер (`analytics/server`)

**Стек.**
- Bun, Effect 4: `HttpApi` из `effect/http-api`, `effect/sql` с драйвером Postgres для Effect 4.
- Сервисы — `Context.Service` со слоями, как в Grill. Тесты — Vitest на настоящем Postgres (`TEST_DATABASE_URL`, схема пересоздаётся перед каждым тестом) через `HttpRouter.toWebHandler`: весь HTTP-конвейер, включая SSE, без открытого порта.

**Хранение — лог и проекции.**
- `events (seq bigserial, id uuid UNIQUE, v, kind, at, received_at, body jsonb)` — неизменяемый лог, источник правды.
- `rejected_events (id, received_at, reason, body)`.
- Проекции:
  - `projects (id, norm_name UNIQUE, display_name)`;
  - `local_projects (local_id PK, project_id, name)`;
  - `calls`, `recordings`, `segments`, `topics`, `cards`, `questions`, `question_events`, `findings`, `finding_events`;
  - `prompt_parts (hash PK, text)`, `agent_calls`, `agent_call_parts`, `agent_call_ops`, `slow_loop_candidates`.
- Приём пакета — одна транзакция:
  1. `INSERT … ON CONFLICT (id) DO NOTHING` в `events`;
  2. для вставленных — применение к проекциям;
  3. ответ со всеми id пакета.
- Проекции без внешних ключей между собой. Снимок сущности применяется, только если его `at` не раньше сохранённого. Поэтому порядок прихода не важен: «действие раньше вопроса» просто вставит событие, а вопрос появится, когда придёт.
- Команда `rebuild` пересчитывает проекции из `events` по `seq`. Так меняют схему проекций без потери данных.

**Склейка проектов.**
- `norm(name)` = trim → схлопнуть пробелы → lower → `ё` в `е`.
- Событие `project`:
  1. найти или создать `projects` по `norm`;
  2. привязать `local_projects.local_id` к нему, с переносом при переименовании;
  3. `display_name` = присланное написание.
- Звонок принадлежит проекту через `local_projects`. Поэтому перенос локального проекта переносит все его звонки без переписывания звонков.
- Опустевший проект скрывается из списка.

**API чтения** (JSON, типы из того же `HttpApi`, клиент для веба генерируется):
- `GET /api/projects`;
- `GET /api/projects/:id` — сводка, агрегаты SQL по проекциям;
- `GET /api/calls/:id` — таймлайн без текстов промптов;
- `GET /api/agent-calls/:id` — детали вызова с частями промпта, ответом и операциями, лениво;
- `GET /api/findings/:id`.

**Живые изменения.**
- `GET /api/live?project=…|call=…` — Server-Sent Events.
- После записи пакета сервер публикует в `PubSub` (в процессе) `seq` и затронутые проект и звонок.
- SSE-поток отдаёт `id: seq` и краткое «что изменилось». Страница перечитывает затронутую часть через API чтения.
- При переподключении браузер шлёт `Last-Event-ID`, и сервер досылает изменения из `events` по `seq`.

Почему SSE, а не WebSocket: поток односторонний, переподключение и `Last-Event-ID` встроены в браузер, а проксировать SSE проще.

### 9. Веб (`analytics/web`)

- Next.js 16, статический экспорт, как Grill. Страницы: `/`, `/project?id=`, `/call?id=`. Динамические сегменты в статическом экспорте требуют `generateStaticParams`, а id известны только во время работы.
- Данные грузятся на клиенте через типизированный клиент `HttpApi`. Обновления приходят по SSE.
- Статику раздаёт тот же сервер Bun: один контейнер, один адрес, без CORS.
- Таймлайн звонка:
  - фразы с отметками вызовов, виртуализированный список (сотни вызовов и тысячи фраз);
  - детали вызова в боковой панели, которая не закрывается от новых данных (spec «Живое обновление»);
  - «следовать за последней фразой» — переключатель.
- Части промпта, совпадающие с прошлым вызовом звонка, помечаются по равенству `hash`.

**Макеты.** [Paper, «Grill — Call Assistant», страница «Аналитика»](https://app.paper.design/file/01M5A05NG88FC2PXKH46DR6K57/p-7-0):
- «B1 Обзор»: данные, загрузка, звонков ещё нет, ошибка загрузки;
- «B2 Звонок»: завершён, идёт сейчас, загрузка, не найден;
- «B · Состояния блоков»: связь в шапке, пустые блоки и фильтры, первая неделя, вкладки раскрытого вызова.

Где макет и spec расходятся, решает spec, пока её не обновили под макет.

**Дизайн-система.**
- `src/components/ui` и токены темы выносятся в workspace-пакет `packages/ui`. Grill импортирует их оттуда, `components.json` указывает алиас `ui` на пакет.
- Это отдельный первый шаг с полным прогоном тестов Grill. Правила shadcn из AGENTS.md переносятся на новый путь.
- Альтернатива — импорт по относительному пути из `analytics/web` в `src/`. Отвергнута: Tailwind 4 должен сканировать чужое дерево, а Next требует `externalDir`. Получается хрупкая связь двух приложений вместо явной зависимости.

### 10. Монорепо и развёртывание

- Корневой `package.json` получает `"workspaces": ["packages/*", "analytics/*"]`. Grill остаётся в корне, его скрипты не меняются.
- Пакеты:
  - `packages/ui`;
  - `analytics/contract` (`@grill/analytics-contract`);
  - `analytics/server`;
  - `analytics/web`.
- `analytics/docker-compose.yml`: `server` (образ Bun; собирает web и раздаёт его, миграции `effect/sql` при старте) и `postgres` с томом.
- Конфигурация через переменные окружения: `DATABASE_URL`, `PORT`.
- CI:
  - Biome, tsc и Vitest для новых пакетов;
  - тест сервера на Postgres в контейнере сервиса;
  - проверка свежести контракта.

## Risks / Trade-offs

- **[Риск] Без входа весь архив разговоров открыт любому, кто есть во внутренней сети.**
  → Это решение команды. В README сервера и в Docker Compose сервер по умолчанию слушает только внутренний интерфейс; публикация наружу — явное действие.
- **[Риск] Склейка по названию соединит разные проекты с одинаковым названием, а веб только читает и не может их развести.**
  → `local_projects` хранит связь локального проекта. Разделение — это переименование проекта в Grill.
- **[Риск] Менеджеры не знают, что звонки уходят на сервер, потому что Grill ничего не показывает.**
  → Предупреждение команды — вне приложения, отдельная строка в чек-листе релиза.
- **[Риск] Рост базы Grill: части сообщений почти не повторяются, окно в 10 минут — до ~15 КБ на вызов.**
  → Около 200 вызовов в час дают порядка 3 МБ в час звонка. Тексты чистятся по `transcriptRetention` (решение 2). Порядок величины проверить на реальном звонке в задаче 2.x.
- **[Риск] Сборка разделами нечаянно изменит байты промпта, и кеш CLI просядет.**
  → Снимочные тесты префикса и сообщения до и после. Сравнение `cache_read` в прогоне `grill-eval` до и после изменения.
- **[Риск] Время событий — часы ноутбука менеджера.**
  → Для порядка внутри звонка это верно, потому что всё с одной машины. Между машинами время сравнивается только на уровне дат звонков.
- **[Компромисс] Снимки сущностей вместо дельт удваивают трафик на частых изменениях (`recompute`).**
  → Снимок вопроса — сотни байт. Зато сервер прост и терпим к потере порядка.
- **[Риск] Старые версии Grill после смены схемы.**
  → Сервер принимает `v` и `v-1`. Неизвестные события сохраняются в `rejected_events` и могут быть применены после обновления сервера через `rebuild`.

## Migration Plan

1. Развернуть сервер (Docker Compose) во внутренней сети и проверить `POST /api/ingest` с образцами из `analytics/contract/fixtures`.
2. Выпустить Grill с миграцией `0013` и `GRILL_ANALYTICS_URL` в CI релиза. Миграция ставит `enabled_since`, старые звонки не отправляются.
3. Откат приложения: релиз без `GRILL_ANALYTICS_URL` выключает отправку. Таблицы журнала остаются и не мешают. Откат сервера: остановить контейнер, Grill копит очередь до 500 МБ.

## Open Questions

- Внутренний хост, адрес сервера и как он попадёт в CI (секрет репозитория или переменная).
- ~~Драйвер Postgres для Effect 4~~ — `@effect/sql-pg` 4.1.0 (свой протокол Postgres, без `pg`); миграции через `Migrator.make` из `effect/sql`.
