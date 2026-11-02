# Design

## Context

Что есть сейчас:

- **Фронтенд шагов 02 и 04.**
  - Экраны и страницы готовы: `src/features/onboarding/pages/{permissions,agent}-page.tsx`.
  - Состояние и действия лежат в `src/data/onboarding-setup.ts`: `requestMicrophone`, `answerMicrophone`, `requestScreenAudio`, `openPrivacySettings`, `recheckPermissions`, `detectAgent`, `installAgent`, `loginAgent`, `recheckAgent`. Сейчас всё это таймеры.
  - Уровень сигнала идёт из `OnboardingBackend.audioLevel`, который реализован только как `layerMock`.
  - Шаг 02 различает macOS и Windows (артборд «02 Разрешения — Windows»).
- **Мост.** `call(() => commands.x())` и `listen(events.x)` в `src/effect/tauri.ts`. Ошибки команд — `CommandError { NotFound | Invalid | Storage }`. `OnboardingBackend` в `TauriLayer` пока использует мок.
- **Права.** Каждая команда объявлена в `command_names.rs`, окну её выдаёт capability. Окна `main` и `onboarding` используют `capabilities/main.json`.
- **Спайки.**
  - Process tap на macOS 14.2+ работает и исключает свой процесс.
  - Публичного preflight для «Запись системного аудио» нет: без доступа tap отдаёт нули.
  - TCC привязан к подписи, ad-hoc подпись меняется с каждой сборкой.
  - Claude Code: `claude auth status --json` отдаёт `loggedIn`, `authMethod`, `subscriptionType`; `claude auth login --claudeai` запускает вход по подписке; `--bare` с подпиской не работает.
  - Код Windows (loopback, сессии микрофона) только компилируется.

## Goals / Non-Goals

**Goals:**

- Реальные статусы на шагах 02 и 04 на macOS. Windows-путь написан и проверяется вручную.
- Те же хуки и экраны: меняется только реализация сервиса. Mock-режим ведёт себя как сейчас, все текущие тесты проходят.
- Путь к CLI и его статус готовы к переиспользованию будущим агентом (задача 6).

**Non-Goals:**

- Полноценный захват звонка и детектор «микрофон занят» (задача 4). Здесь только уровень для проверки.
- Расшифровка в проверке микрофона (`micCheck` остаётся мок до задачи STT).
- Поддержка других CLI агентов, кроме Claude Code.

## Decisions

### Разрешения

**1. Микрофон на macOS — AVFoundation через `objc2-av-foundation`.**
- Состояние: `AVCaptureDevice.authorizationStatus(for: .audio)` → `notDetermined` / `granted` / `denied` (`restricted` тоже `denied`). Системный диалог при этом не появляется.
- Запрос: `requestAccess(for:completionHandler:)`. Колбэк приходит с другого потока, команда ждёт его через `oneshot` и возвращает новое состояние.
- Альтернатива — CoreAudio: открыть вход и ждать промпт. Отклонена: так нельзя отличить «ещё не спрашивали» от «отказано».

**2. Системный звук на macOS — запрос через короткий process tap, состояние через `TCCAccessPreflight`.**
- Запрос: создать глобальный tap на ~0,5 с (код `spikes/audio/src/mac/tap.rs`). На первом создании macOS показывает промпт.
- Состояние: приватная функция `TCCAccessPreflight(kTCCServiceAudioCapture)` из `TCC.framework`. Её ищем через `dlopen`/`dlsym` и результат только читаем. Если функции нет или она вернула непонятное, состояние `unknown`.
- При `unknown` фронтенд показывает «Разрешить» и уровень сигнала. Если уровень нулевой, а звук где-то играет (`kAudioDevicePropertyDeviceIsRunningSomewhere` на устройстве вывода), появляется подсказка открыть настройки.
- Альтернатива — только эвристика «нули = нет доступа». Отклонена как основной путь: в тишине она даёт ложный отказ. Остаётся запасным вариантом.
- Альтернатива — ScreenCaptureKit с полным Screen Recording. Отклонена: промпт пугает сильнее, а нам нужен только звук.

**2a. Доступ к системному звуку виден только новому процессу.** Ручной прогон на macOS 26.6.2 показал: после «Разрешить» в системном диалоге работающий процесс продолжает получать от `TCCAccessPreflight` код 2 («ещё не спрашивали»), а сразу после перезапуска получает 0. Поэтому запрос ждёт ответ только 5 с. Если состояние так и осталось «ещё не спрашивали», шаг предлагает «Перезапустить» (команда `app_restart`: флаг выхода, как у «Выйти» в трее, и `AppHandle::restart`). Перед перезапуском маршрут шага сохраняется в localStorage, и первый экран онбординга один раз открывает его заново (только маршруты `/onboarding…`).

**3. Windows.**
- Микрофон: читаем `HKCU\…\CapabilityAccessManager\ConsentStore\microphone\Value` и `…\microphone\NonPackaged\Value`, плюс политику `HKLM` с тем же путём. `Deny` в любом из них → `denied`, иначе `granted`.
- Запрос: системного диалога для классических приложений нет. «Разрешить» при `denied` открывает `ms-settings:privacy-microphone`, при `granted` сразу возвращает `granted`.
- Системный звук: всегда `granted`, loopback не требует разрешения.

**4. Открытие настроек.**
- macOS: `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` и `…?Privacy_AudioCapture`. Если раздел не открылся, запасной вариант — `…?Privacy`.
- Открываем через `tauri-plugin-opener`. Он уже подключён, но URL идут из Rust: фронтенд передаёт только вид доступа (`microphone` | `systemAudio`), а не URL.

**5. Перечитывание при фокусе.** Фронтенд перечитывает статусы на событие фокуса окна онбординга (`getCurrentWindow().onFocusChanged`) и по кнопке «Проверить». Rust не держит наблюдателей за TCC: изменения TCC не публикуются, опрос был бы дороже.

**6. Info.plist и entitlements.**
- `src-tauri/Info.plist` (Tauri сливает его в бандл): `NSMicrophoneUsageDescription` и `NSAudioCaptureUsageDescription` с текстом на русском.
- `src-tauri/Entitlements.plist`: `com.apple.security.device.audio-input`. Подключается через `bundle.macOS.entitlements` в `tauri.macos.conf.json`.
- Для разработки README описывает стабильную локальную подпись: самоподписанный сертификат «Grill Dev» в `signingIdentity` для `tauri build --debug`. Без неё TCC спрашивает доступ после каждой сборки.

### Агент

**7. Поиск CLI.** Порядок:
1. Сохранённый в настройках `agentPath`, если файл существует и исполняемый.
2. `which::which("claude")` по PATH процесса.
3. Известные места: `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`. На Windows — `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd`.
4. Только macOS: login-shell `"$SHELL" -lc 'command -v claude'` с тайм-аутом 3 с. Это ловит nvm/asdf и пользовательский PATH.

Найденный путь записывается в настройку `agentPath` через существующую команду настроек и событие `DataChanged`. Альтернатива — всегда login-shell. Отклонена: медленно (сотни мс — секунды) и зависит от rc-файлов.

**8. Статус.**
- `claude --version`, затем `claude auth status --json`, каждый с тайм-аутом 10 с.
- Ответ разбирается через serde, неизвестные поля игнорируются. `loggedIn: true` → `ready` + `subscriptionType`, `false` → `needsLogin`. Неразбираемый ответ или ненулевой код → `error` с stderr.
- Процессы запускаются из папки данных приложения, а не из проекта пользователя (`docs/spikes/agent.md`).
- Команды асинхронные (`tokio::process`), при тайм-ауте процесс убивается.

**9. Установка — официальный установщик.**
- macOS: `bash -c "curl -fsSL https://claude.ai/install.sh | bash"`.
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"`.
- Прогресс: событие `AgentInstallProgress` с этапом (`downloading` → `installing` → `verifying`) по строкам stdout. Процент — условный по этапам: точного процента установщик не даёт.
- Отмена убивает процесс.
- Альтернатива — `npm i -g @anthropic-ai/claude-code`. Отклонена: требует Node.js, а аудитория — не разработчики.
- Альтернатива — встроить CLI в бандл. Отклонена: лицензия и обновления CLI не наши.

**10. Вход — код из браузера.** Проверено в 1.1 на CLI 2.1.316: `claude auth login --claudeai` и без TTY, и под псевдотерминалом печатает «Opening browser to sign in…», открывает браузер, выводит ссылку `…/oauth/authorize?code=true&redirect_uri=https://platform.claude.com/oauth/code/callback…` и ждёт ввод «Paste code here if prompted >». Локального callback нет, вход сам не завершается.
- `agent_login_start` запускает CLI со stdin-пайпом, читает stdout до ссылки и возвращает её (кнопка «Открыть страницу ещё раз»). Браузер открывает сам CLI. Если за 15 с ссылки нет, возвращается `External`.
- `agent_login_submit(code)` пишет код и перевод строки в stdin, ждёт завершения процесса (тайм-аут 60 с), затем вызывает `agent_status`. Ненулевой код выхода или `loggedIn: false` → `Invalid { "Код не подошёл" }`, сессия входа закрыта, и «Войти» начинает новую.
- `agent_login_cancel` и тайм-аут сессии в 10 мин убивают процесс.
- Код никуда не пишется и не логируется: в лог поддержки попадает только stdout CLI без строки ввода.
- Альтернатива — открыть Терминал с `claude auth login`. Отклонена пользователем: онбординг обещает обойтись без терминала.
- Альтернатива — интерактивный `/login` внутри сессии `claude` под псевдотерминалом. Отклонена: хрупкий разбор TUI.

**11. Ошибки.** В `CommandError` добавляется вариант `External { message }`: внешний процесс или API ОС ответил ошибкой. Фронтенд в `BackendError.kind` получает `External`. Альтернатива — класть это в `Invalid` или `Storage`. Отклонена: они означают другое, а фронтенд различает реакцию по `kind`.

### Уровень сигнала

**12. Источники.**
- Микрофон — `cpal` (CoreAudio / WASAPI), устройство ввода по умолчанию. Позже — устройство из настроек.
- Системный звук — process tap (macOS) и loopback (Windows) из `spikes/audio`, перенесённые в `src-tauri/src/audio/`.
- Уровень — RMS за окно 100 мс, переведённый в 0–1 по шкале dBFS с полом −60 дБ.

**13. Подписка.**
- Команда `audio_level_start(source)` запускает (или переиспользует) захват источника и считает подписчиков по метке окна. `audio_level_stop(source)` уменьшает счётчик.
- Уровень уходит событием `AudioLevel { source, level }` только окнам-подписчикам (`emit_to`).
- На фронтенде `OnboardingBackend.audioLevel(source)` — это `Stream`: `listen(events.audioLevel)` + `call(start)`, а в финализаторе `call(stop)`. Отписка при уходе со шага уже есть в `use-live-audio.ts`.
- Rust снимает подписки окна, когда оно закрывается или прячется.
- Альтернатива — Tauri `Channel`. Отклонена ради единого механизма подписки моста (`listen`).

**14. Ошибки захвата.** `audio_level_start` возвращает `External` с причиной `noAccess` / `noDevice` / `busy`. Поток уровня падает с этой ошибкой, и экран показывает подсказку.

### Фронтенд

**15. `OnboardingBackend` расширяется.**
- Новые методы: `permissions` (прочитать оба), `requestPermission(kind)`, `openPermissionSettings(kind)`, `agentStatus`, `installAgent` (Stream прогресса), `loginAgent` (Effect до результата, прерываемый) и `audioLevel`.
- `layerMock` берёт нынешние таймеры из `onboarding-setup.ts`.
- Стор `onboarding-setup.ts` оставляет хуки и действия, но действия вызывают сервис через `runCancelable` / `appRuntime.runPromise`.
- `dev`-функции `force*` работают только с моком.
- Статусы бэкенда (`notDetermined`, `needsLogin`…) переводятся в типы экранов (`idle`, `needs-login`…) в адаптере внутри стора.

**16. Платформа.** Вариант экрана Windows выбирается по `platform()` из `@tauri-apps/plugin-os`. В браузере он берётся из `?demo=windows`, как сейчас. Альтернатива — отдельная команда. Отклонена: плагин уже даёт это.

## Risks / Trade-offs

- [`TCCAccessPreflight` — приватный SPI, может исчезнуть в новой macOS] → вызов через `dlsym` с проверкой. Без него остаётся `unknown` и эвристика по нулям. В App Store мы не публикуемся, так что риск отказа ревью нет.
- [Установщик Claude Code — удалённый скрипт] → запускаем только по явному «Установить», URL зашит в Rust (фронтенд не может подставить свой), лог сохраняется для поддержки.
- [CLI поменяет формат вывода входа] → ссылку ищем регуляркой по `https://` в любой строке, а не по точному тексту; если не нашли, ошибка с выводом CLI для поддержки, и вход можно завершить в терминале — шаг заметит его через «Проверить снова».
- [Окружение GUI-приложения без PATH] → цепочка поиска из решения 7, путь сохраняется.
- [Ad-hoc подпись в dev сбрасывает TCC] → стабильная локальная подпись, описанная в README.
- [Windows-код не проверен] → ручной прогон на машине менеджера вместе с аудио-спайком. До него вариант Windows помечен в README как непроверенный.
- [Process tap требует macOS 14.2+] → на более старых macOS системный звук `denied` с текстом «нужна macOS 14.2 или новее». Минимальная версия macOS уже 14.2 (`docs/spikes/audio.md`).

## Migration Plan

Миграции данных нет: `agentPath` — новая необязательная настройка в JSON настроек. Откат — вернуть `OnboardingBackend.layerMock` в `TauriLayer`.

## Open Questions

- Точные якоря `x-apple.systempreferences` для «Только запись системного аудио» на macOS 15/26. Запасной `?Privacy` поведение не меняет.
- Выводит ли официальный установщик прогресс в stdout в стабильном формате. Если нет, прогресс будет по этапам, как в решении 9.
