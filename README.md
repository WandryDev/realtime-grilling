# realtime-grilling

Десктоп-ассистент для discovery-звонков. Концепт — [docs/concept.md](docs/concept.md).

## Стек

- **Tauri 2** — десктоп-оболочка (`src-tauri/`)
- **Next.js 16** (App Router, `output: "export"`) — фронтенд (`src/`), собирается в статику `out/`
- **shadcn/ui** (style `base-nova`, Base UI, lucide) + **Tailwind CSS 4**
- **Ultracite** (Biome) — линтинг и форматирование фронтенда; `rustfmt` + `clippy` для Rust
- **Vitest** + Testing Library — тесты фронтенда; `cargo test` — тесты Rust
- **Changesets** — версии и CHANGELOG
- **OpenSpec** — спецификации и предложения изменений (`openspec/`)
- **bun** — пакетный менеджер

## Команды

```bash
bun install
bun run tauri dev     # приложение целиком (Next dev server на :3000 + окно Tauri)
bun run dev           # только фронтенд в браузере
bun run tauri build   # сборка десктоп-приложения
bun run check         # ultracite check
bun run fix           # ultracite fix
bun run typecheck
bun run test          # vitest (bun run test:watch — в watch-режиме)
bun run e2e           # Playwright по static export (один раз: bun run e2e:install)
bun run changeset     # описать изменение для следующего релиза
bun run icons         # пересобрать src-tauri/icons из мастера src-tauri/app-icon.svg

# Rust (из src-tauri/)
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Компоненты shadcn. Файлы в `src/components/ui` — наш код: их перестилизовали под дизайн Grill, обновлять из registry их нельзя.

- Сначала посмотрите, что изменится: `bunx --bun shadcn@latest add <component> --dry-run` (или `--diff`). Существующий файл, который отличается от registry, dry-run помечает `~ overwrite`. Это то, что *изменилось бы*, а не то, что сделает `add` без `-o`.
- `add` без `-o` не перезаписывает существующий файл: спрашивает «overwrite?» (по умолчанию «нет»). Отвечайте «нет»; нужные правки из `--diff` переносите руками.
- Никогда не запускайте `add` с `-o` / `--overwrite` и `--all`.
- Если файл всё-таки затёрт, верните его через git: `git restore src/components/ui/<file>`.

## Микрофон, системный звук и подпись для разработки (macOS)

macOS (TCC) запоминает доступ к микрофону и к записи системного звука по подписи приложения. Ad-hoc подпись (`signingIdentity: "-"`) меняется с каждой сборкой, поэтому после пересборки macOS спрашивает доступ заново. В `bun run tauri dev` бинарь запускается без бандла, и доступ достаётся терминалу или IDE, а не Grill. Проверять шаг «Разрешения» нужно на бандле со стабильной подписью.

Один раз создайте самоподписанный сертификат «Grill Dev»:

1. «Связка ключей» → меню «Связка ключей» → «Ассистент сертификации» → «Создать сертификат…».
2. Имя — `Grill Dev`, тип идентификации — «Самоподписанный корневой», тип сертификата — «Подпись кода». «Создать».
3. Проверка: `security find-identity -p codesigning` показывает `"Grill Dev"`.

Сборка и запуск с этой подписью:

```bash
bun run tauri build --debug --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"Grill Dev"}}}'
open src-tauri/target/debug/bundle/macos/realtime-grilling.app
```

Подпись одна и та же между сборками, и выданный доступ сохраняется. Начать с чистого листа (снова увидеть системные запросы):

```bash
tccutil reset Microphone com.dev-wandry.realtime-grilling
tccutil reset AudioCapture com.dev-wandry.realtime-grilling
```

Тексты запросов лежат в `src-tauri/Info.plist`, entitlement микрофона — в `src-tauri/Entitlements.plist`. Запись системного звука требует macOS 14.2 или новее (`minimumSystemVersion` в `tauri.macos.conf.json`).

Windows: доступ к микрофону читается из параметров конфиденциальности, системный звук разрешения не требует. Этот путь пока только компилируется и не проверен на реальной машине.

## OpenSpec

Изменения поведения сначала описываются в OpenSpec, потом реализуются:

```text
/opsx:explore            # обсудить идею
/opsx:propose "<идея>"   # proposal, design, specs и tasks в openspec/changes/<change>/
/opsx:apply              # реализовать задачи
/opsx:archive            # перенести итоговые спецификации в openspec/specs/
```

CLI: `bunx openspec list`, `bunx openspec validate`, `bunx openspec view`. Контекст проекта для агента лежит в `openspec/config.yaml`. CodeRabbit папку `openspec/` не ревьюит.

## CI и релизы

- **CI** (`.github/workflows/ci.yml`, на PR; для `main` вызывается из release.yml): Ultracite, typecheck, Vitest, `next build`; `cargo fmt --check`; `clippy -D warnings` и `cargo test` на macOS и Windows.
- **E2E** (джоба `E2E` в том же CI, пока не обязательная в ruleset): Playwright собирает static export, отдаёт `out/` через `scripts/serve-out.ts` и проходит сценарии из `e2e/` в Chromium (как WebView2) и WebKit (как WKWebView), в браузерном mock-режиме. При падении отчёт лежит в артефакте `playwright-report`. Локально: `bun run e2e:install` один раз, затем `bun run e2e` (`E2E_SKIP_BUILD=1` берёт готовый `out/`).
- **Release** (`.github/workflows/release.yml`, на push в `main`):
  1. В PR с пользовательским изменением добавляем changeset (`bun run changeset`).
  2. После мержа в `main` бот открывает/обновляет PR «chore: release» с поднятой версией и `CHANGELOG.md`.
  3. Мерж этого PR прогоняет CI и собирает приложение под macOS (universal) и Windows и публикует GitHub Release `v<version>` с заметками из CHANGELOG.

PR «chore: release» открывается от имени Fine-grained PAT из секрета `RELEASE_TOKEN` (Contents и Pull requests: read/write), иначе на нём не запустится CI.

Версия хранится в `package.json`: `tauri.conf.json` читает её оттуда, а `scripts/sync-version.ts` синхронизирует `Cargo.toml`/`Cargo.lock`.

### Подпись macOS

Релизная сборка macOS подписана Developer ID (hardened runtime) и нотаризована: и приложение, и `.dmg` со степлированным тикетом. Подписывает и нотаризует tauri-cli из переменных `APPLE_*`, `.dmg` нотаризует отдельный шаг в `release.yml`. Перед публикацией Gatekeeper (`spctl`) проверяет оба файла. Если секретов нет, релиз падает, а не выходит без подписи.

Секреты лежат в environment `release` (Settings → Environments). В него можно деплоить только из `main`, поэтому workflow из PR их не получит:

| Секрет | Что это |
|---|---|
| `APPLE_CERTIFICATE` | `.p12` сертификата «Developer ID Application» с закрытым ключом, в base64 |
| `APPLE_CERTIFICATE_PASSWORD` | пароль `.p12` |
| `APPLE_SIGNING_IDENTITY` | имя сертификата: `Developer ID Application: <имя> (<Team ID>)` |
| `APPLE_API_KEY` | Key ID ключа App Store Connect API (роль Developer) |
| `APPLE_API_ISSUER` | Issuer ID того же ключа |
| `APPLE_API_KEY_P8` | содержимое `AuthKey_<Key ID>.p8` |

Сертификат Developer ID действует до 1 февраля 2027 года. После выпуска нового обновите `APPLE_CERTIFICATE` и `APPLE_CERTIFICATE_PASSWORD`.

`signingIdentity: "-"` в `tauri.conf.json` остаётся для локальных сборок: `APPLE_SIGNING_IDENTITY` в CI его перекрывает.

Windows пока не подписан: при первом запуске SmartScreen показывает предупреждение.

## Правила для `main`

Ruleset разрешает мерж в `main` только через PR, когда:

- зелёные проверки CI (`Frontend`, `Rust format`, `Rust (macos-latest)`, `Rust (windows-latest)`) и статус `CodeRabbit`;
- закрыты все inline-треды ревью, то есть actionable-комментарии CodeRabbit. Nitpick-замечания попадают в summary и мерж не блокируют.

CodeRabbit настроен в `.coderabbit.yaml`: профиль `quiet`, ревью на русском, без замечаний по стилю и линту (их ловит CI), сгенерированный и вендорный код исключён.

## Ограничения static export

В Tauri нет Node.js-сервера, поэтому недоступны Server Actions, Route Handlers, middleware, `next/image` с оптимизацией и динамические роуты без `generateStaticParams`. Бэкенд-логика — в Rust-командах Tauri (`invoke`).
