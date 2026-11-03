//! What recognizing a recording runs with: its glossary (design.md decision
//! 9) and the call language (decision 7), read from the database.

use rusqlite::Connection;

use super::{glossary::Glossary, language::CallLanguage};
use crate::{
    error::CommandResult,
    storage::{people, projects, recordings, settings},
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordingContext {
    pub glossary: Glossary,
    pub language: CallLanguage,
}

/// The glossary of the recording's project (none without one) and the
/// `callLanguage` setting. `NotFound` for an unknown recording.
pub fn load(connection: &Connection, recording_id: &str) -> CommandResult<RecordingContext> {
    let recording = recordings::get(connection, recording_id)?;
    let glossary = match &recording.project_id {
        Some(project_id) => {
            let project = projects::get(connection, project_id)?;
            let people = people::list(connection, project_id)?;
            let participants: Vec<String> = recording
                .participant_ids
                .iter()
                .filter_map(|id| people.iter().find(|person| &person.id == id))
                .map(|person| person.name.clone())
                .collect();
            let others: Vec<String> = people
                .iter()
                .filter(|person| !recording.participant_ids.contains(&person.id))
                .map(|person| person.name.clone())
                .collect();
            Glossary::build(
                Some(&project.name),
                &participants,
                &others,
                project.brief.as_ref(),
            )
        }
        None => Glossary::empty(),
    };
    Ok(RecordingContext {
        glossary,
        language: call_language(connection),
    })
}

/// The `callLanguage` setting; Russian when it can't be read.
pub fn call_language(connection: &Connection) -> CallLanguage {
    settings::get(connection)
        .map(|map| settings::call_language(&map))
        .unwrap_or_default()
}
