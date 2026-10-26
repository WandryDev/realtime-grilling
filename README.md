# realtime-grilling

Десктоп-ассистент для discovery-звонков. Концепт — [docs/concept.md](docs/concept.md).

## Стек

- **Tauri 2** — десктоп-оболочка (`src-tauri/`)
- **Next.js 16** (App Router, `output: "export"`) — фронтенд (`src/`), собирается в статику `out/`
- **shadcn/ui** (style `base-nova`, Base UI, lucide) + **Tailwind CSS 4**
- **Ultracite** (Biome) — линтинг и форматирование
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
```

Компоненты shadcn: `bunx --bun shadcn@latest add <component>`.

## Ограничения static export

В Tauri нет Node.js-сервера, поэтому недоступны Server Actions, Route Handlers, middleware, `next/image` с оптимизацией и динамические роуты без `generateStaticParams`. Бэкенд-логика — в Rust-командах Tauri (`invoke`).
