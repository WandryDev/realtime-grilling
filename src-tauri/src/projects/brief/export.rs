//! The brief as Markdown in a folder the manager picked (design.md,
//! decision 9): `<Проект> — бриф.md` with the sections of the project page.
//! An existing file is never overwritten: the next free name `… (2).md`,
//! `… (3).md` is taken instead, and a symlink at the name is refused.

use std::{
    fs::OpenOptions,
    io::{self, Write as _},
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::{
    error::{CommandError, CommandResult},
    storage::{Storage, projects, sources},
};

/// Characters Windows or macOS do not take in a file name.
const FORBIDDEN: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
/// How many numbered names are tried before giving up.
const MAX_COPIES: u32 = 999;

/// Writes the project's brief into `folder` and returns the file's path.
/// `NotFound` for an unknown project, `Invalid` without a brief or a
/// folder, `External` when the file can't be written.
pub async fn export(storage: &Storage, project_id: &str, folder: &str) -> CommandResult<String> {
    let id = project_id.to_owned();
    let (name, markdown) = storage
        .read(move |db| {
            let project = projects::get(db, &id)?;
            let Some(brief) = project.brief else {
                return Err(CommandError::invalid("Брифа пока нет"));
            };
            let names: Vec<(String, String)> = sources::list(db, &id)?
                .into_iter()
                .map(|source| (source.id, source.name))
                .collect();
            Ok((
                project.name.clone(),
                markdown(&project.name, &brief, &names),
            ))
        })
        .await?;
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Err(CommandError::invalid(format!(
            "Папка не найдена: {}",
            folder.display()
        )));
    }
    let path = tauri::async_runtime::spawn_blocking(move || write_new(&folder, &name, &markdown))
        .await
        .map_err(|error| CommandError::external(error.to_string()))??;
    Ok(path.to_string_lossy().into_owned())
}

/// Writes `contents` into a new file [`file_name`] in `folder`, the next
/// number when the name is taken: `create_new` never truncates an existing
/// file and never follows a symlink. A symlink at a name is refused
/// (`Invalid`): it would point the export somewhere else.
fn write_new(folder: &Path, project: &str, contents: &str) -> CommandResult<PathBuf> {
    let cannot = |path: &Path, error: io::Error| {
        CommandError::external(format!("Не удалось записать {}: {error}", path.display()))
    };
    for copy in 1..=MAX_COPIES {
        let path = folder.join(file_name(project, copy));
        let file = OpenOptions::new().write(true).create_new(true).open(&path);
        match file {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())
                    .and_then(|()| file.sync_all())
                    .map_err(|error| cannot(&path, error))?;
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let link = std::fs::symlink_metadata(&path)
                    .is_ok_and(|meta| meta.file_type().is_symlink());
                if link {
                    return Err(CommandError::invalid(format!(
                        "{} — ссылка на другой файл, бриф туда не записан",
                        path.display()
                    )));
                }
            }
            Err(error) => return Err(cannot(&path, error)),
        }
    }
    Err(CommandError::invalid(format!(
        "В папке уже есть {MAX_COPIES} брифов этого проекта: удалите старые"
    )))
}

/// `<Проект> — бриф.md`, without what Windows and macOS forbid: `<>:"/\|?*`,
/// control characters, and dots or spaces at the end of the name.
/// `copy` 1 is the name itself, the next ones are `<Проект> — бриф (2).md`…
pub fn file_name(project: &str, copy: u32) -> String {
    let cleaned: String = project
        .chars()
        .filter(|char| !char.is_control() && !FORBIDDEN.contains(char))
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|char: char| char == '.' || char.is_whitespace());
    let project = if cleaned.is_empty() {
        "Проект"
    } else {
        cleaned
    };
    if copy == 1 {
        format!("{project} — бриф.md")
    } else {
        format!("{project} — бриф ({copy}).md")
    }
}

/// The brief read loosely (a brief saved by `projects_update` may lack
/// fields): what is there is written, in the page's order.
pub fn markdown(project: &str, brief: &Value, sources: &[(String, String)]) -> String {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned()
    };
    let list = |key: &str| -> Vec<&Value> {
        brief
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default()
    };
    let mut out = format!("# {} — бриф\n", project.trim());

    out.push_str("\n## Продукт\n\n");
    let product = text(brief.get("product"));
    out.push_str(if product.is_empty() { "—" } else { &product });
    out.push('\n');

    out.push_str("\n## Стек\n\n");
    let stack: Vec<String> = list("stack")
        .into_iter()
        .map(|item| text(Some(item)))
        .filter(|item| !item.is_empty())
        .collect();
    write_items(&mut out, stack.into_iter().map(|item| format!("- {item}")));

    out.push_str("\n## Модули\n\n");
    let modules = list("modules").into_iter().filter_map(|module| {
        let name = text(module.get("name"));
        (!name.is_empty()).then(|| entry(&name, &text(module.get("description"))))
    });
    write_items(&mut out, modules);

    out.push_str("\n## Глоссарий\n\n");
    let glossary = list("glossary").into_iter().filter_map(|item| {
        let term = text(item.get("term"));
        (!term.is_empty()).then(|| entry(&term, &text(item.get("definition"))))
    });
    write_items(&mut out, glossary);

    out.push_str("\n## Ключевые документы\n\n");
    let documents = list("keyDocuments").into_iter().filter_map(|document| {
        let id = text(document.get("sourceId"));
        let name = sources
            .iter()
            .find(|(source, _)| *source == id)
            .map(|(_, name)| name.clone())?;
        let title = text(document.get("title"));
        let why = text(document.get("why"));
        let about: Vec<&str> = [title.as_str(), why.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
        Some(entry(&name, &about.join(". ")))
    });
    write_items(&mut out, documents);
    out
}

/// `- **name** — text`, or `- **name**` without a text.
fn entry(name: &str, text: &str) -> String {
    if text.is_empty() {
        format!("- **{name}**")
    } else {
        format!("- **{name}** — {text}")
    }
}

fn write_items(out: &mut String, items: impl Iterator<Item = String>) {
    let mut any = false;
    for item in items {
        out.push_str(&item);
        out.push('\n');
        any = true;
    }
    if !any {
        out.push_str("—\n");
    }
}
