# Changesets

Каждое изменение, которое должно попасть в релиз, сопровождается changeset-файлом:

```bash
bun run changeset
```

После мержа в `main` CI собирает все changesets в PR «Version Packages». Мерж этого PR поднимает версию, обновляет `CHANGELOG.md` и запускает сборку релиза под macOS и Windows.
