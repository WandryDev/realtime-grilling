# Сервер аналитики Grill

Принимает журнал звонков от всех Grill команды, собирает звонки в проекты
по названию, хранит всё бессрочно и отдаёт данные и живые изменения вебу
аналитики (`analytics/web`). Подробности — в
`openspec/changes/call-analytics/design.md`, решения 8–10.

> **Без входа.** У сервера нет учётных записей: любой, кто достаёт до его
> адреса, видит все разговоры команды. Запускайте его только во внутренней
> сети или за VPN компании и никогда не публикуйте наружу.

## Запуск

Docker Compose из корня репозитория:

```sh
docker compose -f analytics/docker-compose.yml up -d
```

По умолчанию сервер слушает только `127.0.0.1:8787` этой машины. Чтобы его
видела команда, укажите внутренний адрес машины:

```sh
ANALYTICS_BIND=10.0.0.5 docker compose -f analytics/docker-compose.yml up -d
```

Без Docker, с уже запущенным Postgres:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/realtime-grilling-analytics \
  bun run --filter @grill/analytics-server start
```

## Переменные

| Переменная | По умолчанию | Что это |
|---|---|---|
| `DATABASE_URL` | — | Postgres. Миграции применяются при старте |
| `PORT` | `8787` | Порт |
| `HOST` | `127.0.0.1` | Интерфейс; в контейнере `0.0.0.0` |
| `WEB_DIR` | — | Папка статического экспорта веба; без неё отвечает только API |

Grill отправляет события на адрес из `GRILL_ANALYTICS_URL`: в релизной
сборке он задаётся в CI (переменная репозитория), в debug-сборке —
переменной окружения при запуске.

## API

- `POST /api/ingest` — пакет событий `{ events }`, ответ `{ accepted }`.
- `GET /api/projects`, `/api/projects/:id`, `/api/calls/:id`,
  `/api/agent-calls/:id`, `/api/findings/:id` — чтение для веба.
- `GET /api/live?project=…|call=…` — Server-Sent Events; при переподключении
  `Last-Event-ID` досылает пропущенное.

## Пересборка проекций

Лог `events` — источник правды. После изменения схемы проекций:

```sh
DATABASE_URL=… bun run --filter @grill/analytics-server rebuild
```

## Тесты

Тесты работают на отдельной базе и пересоздают её схему:

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/realtime-grilling-analytics-test \
  bun run --filter @grill/analytics-server test
```
