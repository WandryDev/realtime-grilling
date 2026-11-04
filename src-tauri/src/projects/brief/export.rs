//! The brief as Markdown in a folder the manager picked (design.md,
//! decision 9): `<Проект> — бриф.md` with the sections of the project page.

use std::path::PathBuf;

use serde_json::Value;

use crate::{
    error::{CommandError, CommandResult},
    storage::{Storage, projects, sources},
};

/// Characters Windows or macOS do not take in a file name.
const FORBIDDEN: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

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
    let path = folder.join(file_name(&name));
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&written, markdown))
        .await
        .map_err(|error| CommandError::external(error.to_string()))?
        .map_err(|error| {
            CommandError::external(format!("Не удалось записать {}: {error}", path.display()))
        })?;
    Ok(path.to_string_lossy().into_owned())
}

/// `<Проект> — бриф.md`, without what Windows and macOS forbid: `<>:"/\|?*`,
/// control characters, and dots or spaces at the end of the name.
pub fn file_name(project: &str) -> String {
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
    format!("{project} — бриф.md")
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
