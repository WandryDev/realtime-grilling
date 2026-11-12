## Context

Мотивация — в proposal.md. Что есть сейчас:
- **Фронтенд.** Интеграции живут в двух имитациях, и обе работают даже в приложении (`src/effect/runtime.ts`):
  - `SettingsBackend.connectService` (`src/features/settings/backend.ts`) подключает в настройках;
  - `IntegrationsBackend` (`src/features/onboarding/integrations/backend.ts`) подключает в онбординге: GitHub — код устройства, Outline — адрес и ключ, ClickUp — OAuth.
  - Стор `src/data/integrations.ts` хранит в памяти только `status`, `account` и `error`. Экраны со всеми состояниями нарисованы, заметки дизайнера — в `src/app/dev/screens/onboarding/_integrations.tsx`.
- **Rust.** Кода коннекторов, секретов и MCP нет. HTTP-клиент `reqwest` (rustls) уже используется для загрузки речевых моделей.
- **Источники проекта.** В `project_sources` только файлы: `kind` ограничен `'file'` через CHECK, а `UNIQUE(project_id, sha256)` держит дубликаты по содержимому.
- **Бриф.** `projects::brief_inputs` хеширует входные данные, бриф устаревает, когда меняется хеш. Перед звонком `storage::sources::ready_texts` отдаёт тексты в сборку брифа.
- **Агент** запускается с `--strict-mcp-config --tools ""` (`agent/claude_cli.rs`). Решение пользователя: так и остаётся, данные сервисов достаёт приложение по REST.

## Goals / Non-Goals

**Goals:**
- Общий интерфейс коннектора, на который GitHub и ClickUp встанут без переделки хранения, синхронизации, команд и экранов.
- Outline целиком: вход по ключу, выбор, синхронизация, ошибки.
- Один сервис коннекторов на фронтенде вместо двух имитаций, у него `layerTauri` и `layerMock`.

**Non-Goals:**
- Реализация входа по коду устройства и OAuth в браузере. В интерфейсе они описаны, но реализуются вместе с GitHub и ClickUp.
- Медленный контур, входящие из ClickUp и запись в сервисы: только место в интерфейсе (возможности коннектора).
- Фоновая периодическая синхронизация. Синхронизация идёт по событиям из спецификации.

## Decisions

### 1. Коннектор — описание плюс возможности

Модуль `src-tauri/src/connectors/`:

```rust
pub enum ConnectorKind { Outline, GitHub, ClickUp }
pub enum AuthMethod { ApiKey { host: bool }, DeviceCode, BrowserOAuth }
pub enum Capability { ProjectSources, CallSearch, Inbox, Publish }

pub struct Descriptor {
    kind: ConnectorKind,
    auth: AuthMethod,
    capabilities: &'static [Capability],
    available: bool,          // false → «скоро»
}

trait Connector {             // вход и проверка: есть у каждого
    fn descriptor(&self) -> &'static Descriptor;
    async fn verify(&self, credential: &Credential) -> Result<Account, ConnectorError>;
}

trait SourceProvider: Connector {   // Capability::ProjectSources
    async fn browse(&self, c: &Credential, parent: Option<&ExternalRef>) -> Result<Vec<BrowseNode>, ConnectorError>;
    async fn resolve(&self, c: &Credential, selection: &[SelectionItem]) -> Result<Resolved, ConnectorError>;
    async fn fetch(&self, c: &Credential, docs: &[RemoteDoc]) -> Result<Vec<DocText>, ConnectorError>;
}
```

- `BrowseNode` — узел дерева выбора: `ExternalRef { id, kind: Container | Document }`, название, ссылка, есть ли дети, число документов.
- `resolve` разворачивает выбор (контейнеры, документы, исключения) в список `RemoteDoc { external_id, title, url, version }` без текста. Пункты выбора, которых больше нет, он возвращает отдельно.
- `fetch` возвращает Markdown только для новых и изменённых документов.
- Будущие возможности — отдельные трейты: `CallSearch` (поиск во время звонка), `Inbox` (входящие вопросы ClickUp), `Publish` (отправка итогов и задач). Коннектор реализует только то, что у него есть, а описание перечисляет возможности для экранов.

Как ложатся остальные сервисы:

| Сервис | Вход | Контейнер | Документ |
|---|---|---|---|
| Outline | `ApiKey { host: true }` | коллекция | документ с вложенными |
| GitHub | `DeviceCode` | репозиторий | `README` и `docs/**/*.md` по выбору |
| ClickUp | `BrowserOAuth` | список задач | задача с описанием и комментариями |

Альтернатива — один трейт со всеми методами и заглушками `Unsupported`. Отвергнута: экраны и синхронизация всё равно должны знать, что умеет коннектор, а заглушки прячут это до вызова.

### 2. Секреты: трейт `SecretStore`, крейт `keyring`

- **Запись.** Сервис `com.dev-wandry.realtime-grilling`, имя `connector.<kind>`, значение — JSON `Credential`: `ApiKey { key }` сейчас, `OAuth { access, refresh, expires_at }` для будущих коннекторов. Адрес Outline не секрет и хранится в подключении.
- **Платформы.** `keyring` 3 с `apple-native` и `windows-native`: Keychain и Credential Manager.
- **Тесты и eval.** `SecretStore` — трейт, в тестах фальшивое хранилище в памяти.
- **Где живёт ключ.** Секрет читается только внутри Rust при обращении к сервису. Команды возвращают `Account`, а `Credential` не реализует `Serialize` для интерфейса. В журналах и ошибках ключ маскируется.
- **Отказ Keychain при чтении** (заблокирован, менеджер нажал «Запретить») не считается отзывом: подключение остаётся, ошибка `other` «Нет доступа к Keychain». Ломает подключение только отсутствующий ключ. Если при переподключении старый ключ не читается, подключение ничего не записывает.
- **Порядок записи при подключении.** Сначала проверка, затем запись в Keychain, затем строка подключения в базе. Если упала запись в базу, секрет удаляется.

Альтернатива — шифрованный файл с ключом в данных приложения. Отвергнута: концепт требует системное хранилище, а ключ шифрования всё равно пришлось бы где-то хранить.

### 3. Хранение (миграция `0009`)

- **`connections`.** Ключ — `kind`: одно подключение на сервис. Поля: `status` (`connected` | `error`), `account` (JSON: адрес, `team_id`, название команды, пользователь), `connected_at`, `last_ok_at`, `last_attempt_at`, `error_kind` (`unauthorized` | `forbidden` | `unreachable` | `other`), `error`. Состояние «не подключён» — это отсутствие строки.
- **`connector_selections`.**
  - Поля: `project_id` (каскадное удаление), `connector`, `account_ref` (`team_id`, к которому относится выбор), `item_kind` (`container` | `document` | `exclude`), `external_id`, `title`, `url`, `status` (`ok` | `unavailable`).
  - Уникальность — `UNIQUE(project_id, connector, external_id, item_kind)`.
  - Здесь же хранится исключение отдельного документа (`exclude`). Исключение убирает документ, через что бы он ни попал в проект: из коллекции или как вложенный в выбранный документ. Выбор на фронтенде следует тому же правилу: снятие коллекции или документа убирает оставшиеся от них исключения, а счётчик вычитает только исключения, которые что-то приносит.
  - При повторном сохранении пункт, уже бывший в выборе, сохраняет свой `account_ref`; текущую команду получают только новые пункты. Без подключения выбор можно сократить (без проверки лимита), но не расширить.
- **`project_connector_sync`.** Ключ `(project_id, connector)`. Поля: `last_ok_at`, `last_attempt_at`, `error_kind`, `error`. Отсюда берутся «Обновлено …» и «Не обновлялось: …».
- **`project_sources`** пересобирается: SQLite не меняет CHECK на месте, поэтому таблица создаётся заново с копированием строк.
  - `kind` принимает `'file'` и `'connector'`. Добавлены `connector`, `external_id`, `external_url`, `external_version` и `account_ref` (команда, из которой загружен документ). Пока в выборе есть пункты другой команды, синхронизация защищает только документы этой команды, а свои снятые и архивные документы убирает.
  - У источника из коннектора `stored_path` пустой: текст лежит в базе, копии файла нет. `extension` равен `md`, `size` — длине текста в байтах, `sha256` — хешу текста.
  - `UNIQUE(project_id, sha256)` заменяется частичными индексами: для файлов `UNIQUE(project_id, sha256) WHERE kind = 'file'`, для коннекторов `UNIQUE(project_id, connector, external_id) WHERE kind = 'connector'`. Два разных документа Outline с одинаковым текстом — нормальный случай.
- **Удаление подключения** удаляет только строку `connections` и секрет.

### 4. Синхронизация — общая, над `SourceProvider`

`connectors::sync::sync_project(project, kind)`:
1. Читает выбор, секрет и подключение. Если подключения нет, синхронизация не идёт, а `project_connector_sync` получает «Outline отключён».
2. `resolve` разворачивает выбор. Пункты, которых больше нет, получают `status = unavailable`.
3. Сравнивает результат с источниками проекта по `external_id` и `external_version`, затем вызывает `fetch` для новых и изменённых документов.
4. Применяет изменения одной транзакцией: обновляет, добавляет и удаляет строки `project_sources`, обновляет `project_connector_sync`. После неё уходит одно `DataChanged`. Если не изменилось ничего, строки источников не трогаются, и хеш брифа остаётся прежним.
5. Ошибка `Unauthorized` переводит подключение в `error` и останавливает синхронизацию без изменений источников. `Unreachable` пишется только в `project_connector_sync` и `last_attempt_at` подключения.

Остальное:
- **Одна синхронизация на проект.** Карта `(project, kind) → Shared<Future>`: повторный запрос присоединяется к идущей синхронизации, а не запускает вторую.
- **Лимит 200 документов** проверяется в `resolve` при сохранении выбора, до записи (команда `connector_selection_set`). При синхронизации, если коллекция разрослась сверх лимита, берутся 200 последних изменённых документов, а у источников показывается предупреждение (`outline-connector`, «Выбор документов для проекта»).
- **Перед звонком** обновление брифа у виджета старта сначала вызывает `sync_project` для всех коннекторов проекта с таймаутом 30 с, затем проверяет хеш брифа, как сейчас. Звонок не ждёт ни того, ни другого.
- **Проверка после запуска:** `verify` для каждого подключения в фоне, через 5 с после старта.

### 5. Клиент Outline

- **Запросы.** `POST {origin}/api/{method}`, `Authorization: Bearer`, JSON. Таймаут 15 с. На 429 клиент ждёт `Retry-After` (не больше 60 с) и делает до 3 повторов.
- **Методы:**
  - `auth.info` — проверка, `team` (id и название) и `user`;
  - `collections.list` — коллекции для дерева, страницами по 100;
  - `collections.documents` — дерево документов коллекции: из него строится `browse` и разворачиваются вложенные документы;
  - `documents.list` с `collectionId` — опубликованные документы коллекции страницами по 100, с `updatedAt` и `text`;
  - `documents.info` — отдельный документ.
- **Версия документа** — `updatedAt`. Документ, которого нет в `documents.list` (удалён или архивирован), исчезает из источников.
- **Ошибки:** 401 — `Unauthorized`; 403 на `auth.info` — `Forbidden`: ключ без прав, подключение в ошибке «Нет доступа» с «Обновить ключ»; 403 на коллекцию или документ — пункт `unavailable`; 404 — тоже `unavailable`; сеть, таймаут или не-JSON по адресу — `Unreachable`.
- **Нормализация адреса** — чистая функция с тестами: схема по умолчанию `https`; `http` разрешён только для `localhost` и `127.0.0.1`; путь, query и фрагмент отбрасываются.

### 6. Команды и контракт

Новые команды в `bindings.ts`:
- `connectorsList → ConnectorView[]` — описание, состояние и аккаунт;
- `connectorConnectApiKey(kind, host, key) → ConnectOutcome`, где `ConnectOutcome = { connected: ConnectorView } | { rejected: { field: "host" | "key", reason } }`. Отказ сервиса — ожидаемый ответ, а не `BackendError`, поэтому `BackendError` не расширяется;
- `connectorDisconnect(kind)`;
- `connectorBrowse(kind, parent?) → BrowseNode[]`;
- `connectorSelectionGet(projectId) → ProjectConnectorView[]` — выбор, исключения и состояние синхронизации;
- `connectorSelectionSet(projectId, kind, items) → ProjectConnectorView`. Проверяет лимит и запускает синхронизацию;
- `connectorSync(projectId, kind?)`.

События — `DataChanged` с новыми сущностями `connections` и `connectorSelections`. Источники проекта уже рассылают `projectSources`.

Задел под будущие способы входа: `connectorAuthStart(kind) → AuthSession` (код устройства или ссылка) и событие `ConnectorAuthProgress`. В этом изменении они не реализуются.

### 7. Фронтенд

- **Сервис.** Один `Connectors` (`src/data/services/connectors.ts`) со слоями `layerTauri` и `layerMock`. Он заменяет `SettingsBackend.connectService` и Outline-часть `IntegrationsBackend`.
- **Стор.** `src/data/integrations.ts` переходит на `createSyncedStore`. Адаптер переводит `ConnectorView` в нынешний `IntegrationState` и добавляет `available`, `lastOkAt` и `errorKind`.
- **GitHub и ClickUp в приложении** показываются «скоро»: `available: false` из описания. Их имитации остаются только в `layerMock` для браузерного демо и `/dev`.
- **Экраны:**
  - онбординг Outline и диалог подключения в настройках работают через `connectorConnectApiKey`;
  - шаг «Источники» мастера и блок источников проекта получают дерево выбора (`connectorBrowse`) с поиском по названию и счётчиком документов;
  - строки источников Outline показываются вместе с файлами;
  - «Подключить» в мастере открывает диалог подключения Outline поверх шага «Источники»: черновик мастера живёт в состоянии страницы и не пережил бы переход на онбординг;
  - документы Outline показываются отдельным блоком Outline в разделе «Источники», под документами с компьютера.
- **Тексты:**
  - `AGENT_MCP` («через MCP») заменяется на «Grill сам загружает документы и передаёт агенту их текст»;
  - диалог отключения Outline говорит, что источники останутся с последним текстом.

### 8. Бриф

`brief_inputs` включает источники из коннекторов: id источника, `external_id` и хеш текста. В сборке брифа они идут теми же блоками `F…` с названием `Outline: <title>`. Ключевые документы ссылаются на них как на любой источник.

## Risks / Trade-offs

- **[Keychain спрашивает доступ после каждой пересборки с ad-hoc подписью]** → README уже описывает стабильную dev-подпись. Ключ в Keychain принадлежит приложению по его подписи, поэтому после смены подписи приложение увидит ошибку чтения и предложит «Обновить ключ», а не упадёт.
- **[В `documents.list` может не оказаться `text` на старых self-hosted версиях]** → клиент проверяет поле и для изменённых документов без текста вызывает `documents.info`.
- **[Подключили другую команду Outline]** → выбор хранит `account_ref`. Пункты другой команды показываются «недоступно» с подсказкой, что Outline подключён к другой команде, и ничего не удаляют до решения менеджера.
- **[Большие коллекции раздувают бриф]** → лимит 200 документов и прежний бюджет сборки брифа с пропорциональным сокращением.
- **[Синхронизация перед звонком тратит сеть и время]** → только изменённые документы получают текст, таймаут 30 с, звонок не ждёт.
- **[Windows Credential Manager ограничивает размер секрета (2.5 КБ)]** → ключи и OAuth-токены укладываются. Если не уложится, секрет делится на части при появлении такого коннектора.

## Migration Plan

- **`0009`** создаёт `connections`, `connector_selections`, `project_connector_sync` и пересобирает `project_sources` с переносом всех строк-файлов без изменений. Тест миграции проверяет, что файлы, их тексты и хеш брифа те же.
- **Откат** — revert изменения. Миграции только вперёд, новые таблицы останутся неиспользуемыми. Секреты в Keychain удаляются отключением до отката.

## Open Questions

- Отдаёт ли `documents.list` поле `text` в облачном Outline на текущей версии API. Ответ меняет только число запросов (см. риски), а не поведение.
