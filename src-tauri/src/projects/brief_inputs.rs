//! What a project's brief is built from, and its fingerprint
//! (projects-people-brief design.md, decision 7).
//!
//! The fingerprint is the SHA-256 of a canonical JSON of the description,
//! the notes, the people (sorted by id: name, role, profile) and the sorted
//! `sha256` of the `ready` files; when the project has `ready` documents of
//! connectors, also their id, external id and `sha256` (connectors-outline
//! design.md, decision 8), so a project of files only keeps its old
//! fingerprint. The project's name is not part of it:
//! renaming leaves the brief fresh. The brief build (group 2) reads
//! [`read`] before calling the agent and stores [`BriefInputs::fingerprint`]
//! with the brief ([`crate::storage::projects::save_brief`]); the project
//! read compares it with [`fingerprint`].

use rusqlite::Connection;
use serde_json::{Value, json};

use super::sha256_hex;
use crate::{
    error::{CommandError, CommandResult},
    storage::{
        people,
        sources::{self, ConnectorHash, ReadySource},
    },
};

/// A person of the client, as the brief sees them.
#[derive(Debug, Clone, PartialEq)]
pub struct BriefPerson {
    pub id: String,
    pub name: String,
    pub role: String,
    pub profile: Value,
}

/// Everything a brief of the project is built from.
#[derive(Debug, Clone, PartialEq)]
pub struct BriefInputs {
    pub project_id: String,
    /// Not in the fingerprint; for the prompt.
    pub project_name: String,
    pub description: String,
    pub notes: String,
    /// Sorted by id.
    pub people: Vec<BriefPerson>,
    /// The `ready` documents with their text, in the order they were added.
    pub sources: Vec<ReadySource>,
    /// SHA-256 (hex) of the inputs above, as [`fingerprint`] computes it.
    pub fingerprint: String,
}

impl BriefInputs {
    /// Nothing to build a brief from: no description, notes, people or
    /// readable documents.
    pub fn is_empty(&self) -> bool {
        self.description.trim().is_empty()
            && self.notes.trim().is_empty()
            && self.people.is_empty()
            && self.sources.is_empty()
    }
}

struct Basics {
    name: String,
    description: String,
    notes: String,
}

fn basics(connection: &Connection, project_id: &str) -> CommandResult<Basics> {
    connection
        .query_row(
            "SELECT name, description, notes FROM projects WHERE id = ?1",
            [project_id],
            |row| {
                Ok(Basics {
                    name: row.get(0)?,
                    description: row.get(1)?,
                    notes: row.get(2)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                CommandError::not_found(format!("Проект {project_id} не найден"))
            }
            other => other.into(),
        })
}

fn people_of(connection: &Connection, project_id: &str) -> CommandResult<Vec<BriefPerson>> {
    let mut people: Vec<BriefPerson> = people::list(connection, project_id)?
        .into_iter()
        .map(|person| BriefPerson {
            id: person.id,
            name: person.name,
            role: person.role,
            profile: person.profile,
        })
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(people)
}

/// The inputs of the project's brief with their fingerprint. `NotFound` for
/// an unknown project.
pub fn read(connection: &Connection, project_id: &str) -> CommandResult<BriefInputs> {
    let basics = basics(connection, project_id)?;
    let people = people_of(connection, project_id)?;
    let sources = sources::ready_texts(connection, project_id)?;
    let hashes = sources::ready_hashes(connection, project_id)?;
    let connected = sources::ready_connector_hashes(connection, project_id)?;
    let fingerprint = hash(
        &basics.description,
        &basics.notes,
        &people,
        &hashes,
        &connected,
    );
    Ok(BriefInputs {
        project_id: project_id.to_owned(),
        project_name: basics.name,
        description: basics.description,
        notes: basics.notes,
        people,
        sources,
        fingerprint,
    })
}

/// The fingerprint of the project's current inputs, without reading the
/// documents' text. `NotFound` for an unknown project.
pub fn fingerprint(connection: &Connection, project_id: &str) -> CommandResult<String> {
    let basics = basics(connection, project_id)?;
    let people = people_of(connection, project_id)?;
    let hashes = sources::ready_hashes(connection, project_id)?;
    let connected = sources::ready_connector_hashes(connection, project_id)?;
    Ok(hash(
        &basics.description,
        &basics.notes,
        &people,
        &hashes,
        &connected,
    ))
}

/// `source_hashes` (of files) must be sorted, `people` and `connected`
/// sorted by id.
fn hash(
    description: &str,
    notes: &str,
    people: &[BriefPerson],
    source_hashes: &[String],
    connected: &[ConnectorHash],
) -> String {
    let people: Vec<Value> = people
        .iter()
        .map(|person| {
            json!({
                "name": person.name,
                "role": person.role,
                "profile": person.profile,
            })
        })
        .collect();
    let mut inputs = json!({
        "description": description,
        "notes": notes,
        "people": people,
        "sources": source_hashes,
    });
    // Only when there are some: a project of files keeps its fingerprint.
    if !connected.is_empty() {
        let connected: Vec<Value> = connected
            .iter()
            .map(|source| {
                json!({
                    "id": source.id,
                    "externalId": source.external_id,
                    "sha256": source.sha256,
                })
            })
            .collect();
        inputs["connectorSources"] = Value::Array(connected);
    }
    let mut canonical = String::new();
    write_canonical(&inputs, &mut canonical);
    sha256_hex(canonical.as_bytes())
}

/// JSON with object keys sorted at every level and no whitespace, so equal
/// values always hash the same whatever order their keys were written in.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&fields[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(value: &Value) -> String {
        let mut out = String::new();
        write_canonical(value, &mut out);
        out
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_level() {
        let a = json!({ "b": 1, "a": { "y": [ { "d": 1, "c": "х" } ], "x": null } });
        let b = json!({ "a": { "x": null, "y": [ { "c": "х", "d": 1 } ] }, "b": 1 });
        assert_eq!(canonical(&a), canonical(&b));
        assert_eq!(
            canonical(&a),
            r#"{"a":{"x":null,"y":[{"c":"х","d":1}]},"b":1}"#
        );
    }

    #[test]
    fn the_hash_follows_every_input_but_not_the_order_of_profile_keys() {
        let person = |profile: Value| BriefPerson {
            id: "p1".to_owned(),
            name: "Ольга".to_owned(),
            role: "CEO".to_owned(),
            profile,
        };
        let base = hash(
            "описание",
            "заметки",
            &[person(json!({ "tech": 1, "notes": "без жаргона" }))],
            &["a".repeat(64)],
            &[],
        );
        assert_eq!(base.len(), 64);
        assert_eq!(
            base,
            hash(
                "описание",
                "заметки",
                &[person(json!({ "notes": "без жаргона", "tech": 1 }))],
                &["a".repeat(64)],
                &[],
            )
        );
        for other in [
            hash(
                "другое",
                "заметки",
                &[person(json!({}))],
                &["a".repeat(64)],
                &[],
            ),
            hash(
                "описание",
                "",
                &[person(json!({ "tech": 1, "notes": "без жаргона" }))],
                &["a".repeat(64)],
                &[],
            ),
            hash(
                "описание",
                "заметки",
                &[person(json!({ "tech": 2, "notes": "без жаргона" }))],
                &["a".repeat(64)],
                &[],
            ),
            hash(
                "описание",
                "заметки",
                &[person(json!({ "tech": 1, "notes": "без жаргона" }))],
                &[],
                &[],
            ),
            hash(
                "описание",
                "заметки",
                &[person(json!({ "tech": 1, "notes": "без жаргона" }))],
                &["a".repeat(64)],
                &[ConnectorHash {
                    id: "s1".to_owned(),
                    external_id: "doc".to_owned(),
                    sha256: "b".repeat(64),
                }],
            ),
        ] {
            assert_ne!(base, other);
        }
    }
}
