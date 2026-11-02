# Tasks

## 1. Проверка поведения CLI и ошибки

- [x] 1.1 Вручную проверить на macOS поведение `claude auth login --claudeai` без TTY (запуск из процесса без терминала, stdin закрыт): открывает ли он браузер сам, печатает ли URL, завершается ли после входа. Записать итог в `design.md` (решение 10) и выбрать вариант: ждать процесс / поймать URL / открыть Терминал. Проверка: в design.md записан наблюдённый вывод и выбранный вариант.
- [x] 1.2 Добавить `CommandError::External { message }` в `src-tauri/src/error.rs` и `"External"` в `BackendErrorKind` и декодер ошибок в `src/effect/tauri.ts`. Проверка: `cargo test`; Vitest-тест моста декодирует `{ kind: "External" }` в `BackendError.kind === "External"`.

## 2. Разрешения (Rust)

- [x] 2.1 Модуль `src-tauri/src/permissions/` с типами `PermissionKind { Microphone, SystemAudio }` и `PermissionState { NotDetermined, Granted, Denied, Unknown }` (specta) и командами `permissions_get`, `permission_request(kind)`, `permission_open_settings(kind)`. Объявить их в `command_names.rs` и выдать только в `capabilities/main.json`. Проверка: тест манифеста команд зелёный; ACL-тест — вызов `permissions_get` из окна `overlay` отклоняется.
- [x] 2.2 macOS, микрофон: `objc2-av-foundation` — `authorizationStatus` и `requestAccess` с ожиданием колбэка (oneshot, без блокировки главного потока). Проверка: юнит-тест перевода `AVAuthorizationStatus` → `PermissionState`; вручную — первый «Разрешить» показывает системный диалог, ответ меняет состояние.
- [x] 2.3 macOS, системный звук: перенести tap из `spikes/audio/src/mac/tap.rs` в `src-tauri/src/audio/mac/`, запрос — tap на 0,5 с, состояние — `TCCAccessPreflight` через `dlopen`/`dlsym` с fallback `Unknown`; на macOS < 14.2 — `Denied` с сообщением о версии. Проверка: юнит-тест перевода кодов preflight; вручную — запрос показывает промпт «Запись системного аудио».
- [x] 2.4 Windows: микрофон по реестру `ConsentStore\microphone` (`Value`, `NonPackaged\Value`, политика HKLM), системный звук всегда `Granted`, запрос при `Denied` открывает `ms-settings:privacy-microphone`. Проверка: юнит-тест разбора значений реестра на фикстурах; `cargo check --target x86_64-pc-windows-msvc` в CI проходит.
- [x] 2.5 `permission_open_settings`: URL `x-apple.systempreferences:…?Privacy_Microphone` / `…?Privacy_AudioCapture` с запасным `…?Privacy`, на Windows `ms-settings:privacy-microphone`; URL только из Rust. Проверка: юнит-тест выбора URL по `kind` и ОС; вручную открывается нужный раздел.
- [x] 2.6 `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` на русском), `src-tauri/Entitlements.plist` (`com.apple.security.device.audio-input`), подключение в `tauri.macos.conf.json`; раздел README про стабильную dev-подпись. Проверка: `bun run tauri build --debug`, `plutil -p` по `Info.plist` бандла показывает оба ключа, `codesign -d --entitlements -` показывает entitlement.

## 3. Агент (Rust)

- [x] 3.1 Модуль `src-tauri/src/agent/`: поиск CLI по цепочке из design.md (сохранённый `agentPath` → PATH через `which` → известные места → login-shell на macOS с тайм-аутом 3 с), запись найденного пути в настройку `agentPath`. Проверка: `cargo test` с временной папкой и фейковым `claude`-скриптом — находит по известному месту, перезаписывает протухший `agentPath`.
- [x] 3.2 Команда `agent_status` → `AgentState { NotInstalled | NeedsLogin { version } | Ready { version, subscriptionType } | Error { message } }`: `--version` и `auth status --json` через `tokio::process` с тайм-аутом 10 с, cwd — папка данных приложения. Проверка: тесты на фейковом скрипте — вошёл / не вошёл / мусор в stdout / зависание дольше тайм-аута (процесс убит, `Error`).
- [x] 3.3 Команда `agent_install` и `agent_install_cancel`: официальный установщик для ОС (URL зашит в Rust), событие `AgentInstallProgress { stage }` окну-инициатору, лог установки сохраняется для «Скопировать для поддержки», после успеха — `agent_status`. Проверка: тест с подменённой командой установщика (успех, ненулевой код, отмена убивает процесс); вручную на macOS без CLI — установка проходит до `NeedsLogin`.
- [x] 3.4 Команды `agent_login_start` (запуск CLI со stdin-пайпом, ссылка из stdout), `agent_login_submit(code)` (код в stdin, ожидание выхода, `agent_status`, неверный код → `Invalid`) и `agent_login_cancel`; тайм-аут сессии 10 мин, процесс не остаётся висеть, код не попадает в лог. Проверка: тесты с фейковым CLI — верный код → `Ready`, неверный → `Invalid`, отмена убивает процесс; вручную — вход по подписке через поле кода переводит шаг в `ready`.
- [x] 3.5 Выдать команды агента в `capabilities/main.json`, объявить в `command_names.rs`, перегенерировать `src/bindings.ts`. Проверка: тест манифеста и `git diff --exit-code src/bindings.ts` после `cargo test`.

## 4. Уровень сигнала (Rust)

- [x] 4.1 `src-tauri/src/audio/level.rs`: RMS за 100 мс → 0–1 по dBFS с полом −60 дБ. Проверка: юнит-тесты на синусе, тишине и клиппинге.
- [x] 4.2 Источник «микрофон» на `cpal` (устройство ввода по умолчанию) и источник «системный звук» (tap на macOS, loopback из `spikes/audio/src/win/loopback.rs` на Windows) с одним захватом на источник и счётчиком подписчиков по метке окна. Проверка: тест менеджера подписок на фейковом источнике — второй подписчик не открывает устройство повторно, последний `stop` закрывает его.
- [x] 4.3 Команды `audio_level_start(source)` / `audio_level_stop(source)` и событие `AudioLevel { source, level }` только окнам-подписчикам; снятие подписок при закрытии или скрытии окна; ошибки `External` с причиной `noAccess` / `noDevice` / `busy`. Проверка: тест — событие не уходит окну без подписки; вручную — при уходе со шага индикатор микрофона macOS гаснет в течение секунды.
- [x] 4.4 Признак «звук где-то играет» (`DeviceIsRunningSomewhere` устройства вывода на macOS) в составе события уровня системного звука. Проверка: вручную — при воспроизведении в другом приложении флаг `true`, в тишине `false`.

## 5. Фронтенд

- [x] 5.1 Расширить контракт `OnboardingBackend` методами из design.md (решение 15); перенести таймеры из `src/data/onboarding-setup.ts` в `layerMock` без изменения поведения. Проверка: все существующие тесты онбординга (`screens-onboarding*`, `app-onboarding*`) зелёные без правок.
- [x] 5.2 `OnboardingBackend.layerTauri` через `call` / `listen` и адаптер статусов бэкенда в типы экранов (`notDetermined` → `idle`, `needsLogin` → `needs-login`, …); подключить в `TauriLayer`. Проверка: Vitest с `fake-tauri.ts` — шаги «Разрешения» и «Агент» показывают состояния из фейкового IPC, отмена установки вызывает `agent_install_cancel`.
- [x] 5.3 Перечитывать разрешения и статус агента при фокусе окна онбординга и по «Проверить»; подсказка «нет доступа к системному звуку» при `unknown` + нули + `playing`; вариант экрана Windows по `platform()` из `tauri-plugin-os` (добавить плагин в Rust и `@tauri-apps/plugin-os`, право `os:default` для `main.json`), в браузере — по `?demo=windows`. Проверка: Vitest — событие фокуса вызывает повторное чтение; тест подсказки по последовательности уровней.
- [x] 5.4 Ошибки `External` из захвата и агента: текст на экране и «Скопировать для поддержки» с логом установки. Проверка: Vitest на ошибку `noDevice` в индикаторе и на ошибку установки.
- [x] 5.5 Состояние шага «Агент» «вход начат»: поле «Код из браузера» (`Field` + `Input`), «Подтвердить», «Открыть страницу ещё раз», «Отменить», ошибка у поля на неверный код — в стиле существующей карточки агента; превью в `/dev/screens/onboarding`. Проверка: Vitest — ввод кода вызывает `agent_login_submit`, ошибка `Invalid` показывается у поля.

## 6. Интеграционная проверка

- [x] 6.1 Прогнать `bun run check`, `typecheck`, `test`, `build`, `bun run e2e`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `git diff --exit-code src/bindings.ts`. Проверка: всё зелёное.
- [ ] 6.2 Ручной прогон в `bun run tauri dev` на macOS со стабильной подписью: шаг 02 с нуля (промпты, отказ → настройки → возврат фокусом), шаг 04 без CLI (установка → вход → `ready`) и с готовым CLI. Проверка: сценарии `system-permissions`, `agent-setup`, `audio-check` выполняются.
- [ ] 6.3 Добавить changeset (`minor`) и отметить пункты в ClickUp (задача «Онбординг окружения», подзадачи 1amp06q2bfb, 1amp06q2bft). Проверка: `.changeset/*.md` есть; чеклисты в ClickUp обновлены.

## Workflow follow-up

- Ручная проверка Windows-пути (реестр микрофона, loopback, установка и вход Claude Code на Windows) — на машине менеджера вместе с аудио-спайком.
