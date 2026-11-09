//! `grill-eval brief <corpus>`: the corpus's brief rebuilt with the current
//! brief prompt (question-quality task 3.4), from the corpus's materials:
//! the description, the notes, the people and the documents' texts. The
//! call is the app's own (`projects/brief/run.rs`: the message, the rules,
//! the schema, the model); only where the materials come from differs.
//!
//! The new brief replaces the corpus's, which is kept as `briefPrevious`.
//! The corpus's documents have no ids of the app, so a key document points
//! at the document's name.

use std::{path::Path, sync::Arc};

use serde_json::Value;
use tokio::sync::oneshot;

use super::corpus::Corpus;
use crate::{
    agent::{
        claude_cli::{Agent, Usage},
        process::TreeSlot,
    },
    projects::{
        brief::{
            input,
            run::{self, PromptFile},
        },
        brief_inputs::{BriefInputs, BriefPerson},
        sha256_hex,
    },
    storage::sources::ReadySource,
};

/// What a brief of `corpus` is built from. A corpus without a project, or
/// with nothing to build from, is an error.
pub fn inputs(corpus: &Corpus) -> Result<BriefInputs, String> {
    let project = corpus
        .project
        .as_ref()
        .ok_or("В наборе нет проекта: бриф не из чего собирать")?;
    let mut people: Vec<BriefPerson> = corpus
        .people
        .iter()
        .map(|person| BriefPerson {
            id: person.id.clone(),
            name: person.name.clone(),
            role: person.role.clone(),
            profile: person.profile.clone(),
        })
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    let sources = project
        .sources
        .iter()
        .map(|source| ReadySource {
            id: source.name.clone(),
            name: source.name.clone(),
            extension: Path::new(&source.name)
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_owned(),
            sha256: sha256_hex(source.text.as_bytes()),
            text: source.text.clone(),
            truncated: false,
        })
        .collect();
    let inputs = BriefInputs {
        project_id: corpus.name.clone(),
        project_name: project.name.clone(),
        description: project.description.clone(),
        notes: project.notes.clone(),
        people,
        sources,
        // Only the app compares it, to see the brief is stale.
        fingerprint: String::new(),
    };
    if inputs.is_empty() {
        return Err(
            "Не из чего собирать бриф: в наборе нет описания, заметок, людей и документов"
                .to_owned(),
        );
    }
    Ok(inputs)
}

/// Rebuilds the brief of `corpus` with `agent` and puts it in the corpus,
/// the old one under `briefPrevious`. The rules go to a file in
/// `prompt_dir`. Returns what the call cost.
pub async fn run(
    corpus: &mut Corpus,
    agent: Arc<dyn Agent>,
    prompt_dir: &Path,
) -> Result<Usage, String> {
    let inputs = inputs(corpus)?;
    let message = input::compose(&inputs)?;
    let prompt = PromptFile::write(prompt_dir, &format!("corpus-{}", corpus.name))
        .map_err(|error| format!("Не удалось записать промпт брифа: {error}"))?;
    let request = run::request(&prompt, &message, TreeSlot::default(), None);
    let (_cancel, cancelled) = oneshot::channel();
    let reply = agent
        .run(request, cancelled)
        .await
        .map_err(|error| error.to_string())?;
    drop(prompt);
    run::log_cost(&corpus.name, &reply.usage, &message);
    let brief = run::brief_of(reply.patch, &message)?;
    let value: Value = serde_json::to_value(&brief).map_err(|error| error.to_string())?;
    let project = corpus
        .project
        .as_mut()
        .ok_or("В наборе нет проекта: бриф не из чего собирать")?;
    project.brief_previous = project.brief.replace(value);
    Ok(reply.usage)
}

#[cfg(all(test, unix))]
mod tests;
