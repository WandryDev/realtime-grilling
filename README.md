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
bun run changeset     # описать изменение для следующего релиза

# Rust (из src-tauri/)
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Компоненты shadcn: `bunx --bun shadcn@latest add <component>`.

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
- **Release** (`.github/workflows/release.yml`, на push в `main`):
  1. В PR с пользовательским изменением добавляем changeset (`bun run changeset`).
  2. После мержа в `main` бот открывает/обновляет PR «chore: release» с поднятой версией и `CHANGELOG.md`.
  3. Мерж этого PR прогоняет CI и собирает приложение под macOS (universal) и Windows и публикует GitHub Release `v<version>` с заметками из CHANGELOG.

PR «chore: release» открывается от имени Fine-grained PAT из секрета `RELEASE_TOKEN` (Contents и Pull requests: read/write), иначе на нём не запустится CI.

Версия хранится в `package.json`: `tauri.conf.json` читает её оттуда, а `scripts/sync-version.ts` синхронизирует `Cargo.toml`/`Cargo.lock`.

Сборки пока не подписаны: macOS — ad-hoc подпись (первый запуск через «Открыть» в контекстном меню), Windows — предупреждение SmartScreen.

## Правила для `main`

Ruleset разрешает мерж в `main` только через PR, когда:

- зелёные проверки CI (`Frontend`, `Rust format`, `Rust (macos-latest)`, `Rust (windows-latest)`) и статус `CodeRabbit`;
- закрыты все inline-треды ревью, то есть actionable-комментарии CodeRabbit. Nitpick-замечания попадают в summary и мерж не блокируют.

CodeRabbit настроен в `.coderabbit.yaml`: профиль `quiet`, ревью на русском, без замечаний по стилю и линту (их ловит CI), сгенерированный и вендорный код исключён.

## Ограничения static export

В Tauri нет Node.js-сервера, поэтому недоступны Server Actions, Route Handlers, middleware, `next/image` с оптимизацией и динамические роуты без `generateStaticParams`. Бэкенд-логика — в Rust-командах Tauri (`invoke`).
