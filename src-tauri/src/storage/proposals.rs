//! Proposals to update the brief and the people's profiles after a call
//! (post-call design.md, decisions 5 and 8).
//!
//! The build writes them `pending` ([`replace_pending`], inside
//! `summaries::save_build`); the manager's decision is stored with
//! [`set_decision`]. Applying a proposal to the brief or a profile, and
//! undoing it, is [`apply`]'s: it changes the data and the decision in one
//! transaction and returns the `DataChanged` of the project or the person.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{
    call_state::{conversion, typed},
    calls,
    json::{self, Json},
    new_id, now_ms, people, required,
    summaries::CallEvidence,
};
use crate::error::{CommandError, CommandResult};

pub mod apply;

/// What a proposal updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProposalTarget {
    /// The project's brief: `product`, `stack`, `modules`, `glossary`.
    Brief,
    /// A person's profile (`personId`): `role`, `tech`, `project`,
    /// `howToAsk`, `portrait:<label>`, `notes`.
    Person,
}

impl ProposalTarget {
    fn as_str(self) -> &'static str {
        match self {
            Self::Brief => "brief",
            Self::Person => "person",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "brief" => Ok(Self::Brief),
            "person" => Ok(Self::Person),
            other => Err(conversion(format!("unknown proposal target {other}"))),
        }
    }
}

/// What a proposal rests on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProposalKind {
    /// The client said it: `evidence` holds the quotes.
    Said,
    /// "вывод агента".
    Inferred,
}

impl ProposalKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Said => "said",
            Self::Inferred => "inferred",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "said" => Ok(Self::Said),
            "inferred" => Ok(Self::Inferred),
            other => Err(conversion(format!("unknown proposal kind {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProposalDecision {
    Pending,
    Accepted,
    Rejected,
}

impl ProposalDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "rejected" => Ok(Self::Rejected),
            other => Err(conversion(format!("unknown proposal decision {other}"))),
        }
    }
}

/// What accepting a proposal wrote, for its undo (decision 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalApplied {
    /// The value written (for the notes: the line added).
    pub written: Value,
    /// The value before; `null` when there was none (or for the notes).
    pub previous: Option<Value>,
    /// For the notes: the accept added the «Из звонков» heading, so the
    /// undo that empties the section removes it too.
    #[serde(default)]
    pub section_added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub call_id: String,
    pub target: ProposalTarget,
    /// Set when `target` is `person`.
    pub person_id: Option<String>,
    pub field: String,
    /// The value when the proposal was made, taken from the data; `null`
    /// when there was none. Levels 1–5 are text too (`"4"`).
    pub before: Option<String>,
    pub after: String,
    pub kind: ProposalKind,
    pub evidence: Vec<CallEvidence>,
    pub decision: ProposalDecision,
    /// The manager's text of "Изменить и принять".
    pub edited: Option<String>,
    pub applied: Option<ProposalApplied>,
    /// When it was accepted or rejected; `null` while pending.
    pub decided_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A proposal of the build, after its checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProposal {
    pub target: ProposalTarget,
    /// Set for `person`, absent for `brief`.
    pub person_id: Option<String>,
    pub field: String,
    pub before: Option<String>,
    pub after: String,
    pub kind: ProposalKind,
    pub evidence: Vec<CallEvidence>,
}

/// A decision to store: replaces the decision, `edited` and `applied`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionChange {
    pub decision: ProposalDecision,
    pub edited: Option<String>,
    pub applied: Option<ProposalApplied>,
}

const SELECT: &str = "SELECT id, call_id, target, person_id, field, before_value, after_value,
       kind, evidence, decision, edited, applied, decided_at, created_at, updated_at
  FROM call_proposals";

fn from_row(row: &Row) -> rusqlite::Result<Proposal> {
    let target: String = row.get(2)?;
    let kind: String = row.get(7)?;
    let Json(evidence) = row.get(8)?;
    let decision: String = row.get(9)?;
    let applied = json::optional(row.get(11)?);
    Ok(Proposal {
        id: row.get(0)?,
        call_id: row.get(1)?,
        target: ProposalTarget::parse(&target)?,
        person_id: row.get(3)?,
        field: row.get(4)?,
        before: row.get(5)?,
        after: row.get(6)?,
        kind: ProposalKind::parse(&kind)?,
        evidence: typed(evidence, 8)?,
        decision: ProposalDecision::parse(&decision)?,
        edited: row.get(10)?,
        applied: applied.map(|value| typed(value, 11)).transpose()?,
        decided_at: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn many(connection: &Connection, filter: &str, key: &str) -> CommandResult<Vec<Proposal>> {
    let mut statement = connection.prepare(&format!("{SELECT} {filter}"))?;
    let rows = statement.query_map([key], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Proposal> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Предложение {id} не найдено")))
}

/// Every proposal of a call, oldest first. `NotFound` for an unknown call.
pub fn list(connection: &Connection, call_id: &str) -> CommandResult<Vec<Proposal>> {
    calls::project_of(connection, call_id)?;
    many(
        connection,
        "WHERE call_id = ?1 ORDER BY created_at, id",
        call_id,
    )
}

/// The pending proposals about a person from every call, newest first
/// (the person's page). `NotFound` for an unknown person.
pub fn pending_for_person(
    connection: &Connection,
    person_id: &str,
) -> CommandResult<Vec<Proposal>> {
    people::get(connection, person_id)?;
    many(
        connection,
        "WHERE person_id = ?1 AND decision = 'pending' ORDER BY created_at DESC, id DESC",
        person_id,
    )
}

/// Adds a pending proposal to a call. `NotFound` for an unknown call or
/// person; `Invalid` for a call without a project, a person of another
/// project, a person missing (or given) for the target, a blank field or
/// value.
pub fn insert(
    connection: &Connection,
    call_id: &str,
    new: &NewProposal,
) -> CommandResult<Proposal> {
    let project_id = calls::project_of(connection, call_id)?
        .ok_or_else(|| CommandError::invalid("У звонка без проекта нет предложений"))?;
    match (new.target, &new.person_id) {
        (ProposalTarget::Brief, None) => {}
        (ProposalTarget::Person, Some(person_id)) => {
            let person = people::get(connection, person_id)?;
            if person.project_id != project_id {
                return Err(CommandError::invalid(format!(
                    "{} из другого проекта: предложение не относится к звонку",
                    person.name
                )));
            }
        }
        (ProposalTarget::Brief, Some(_)) => {
            return Err(CommandError::invalid(
                "Предложение по брифу не относится к человеку",
            ));
        }
        (ProposalTarget::Person, None) => {
            return Err(CommandError::invalid("Предложение по профилю без человека"));
        }
    }
    let field = required(&new.field, "У предложения нет поля")?;
    let after = required(&new.after, "Предложение без нового значения")?;
    let id = new_id();
    connection.execute(
        "INSERT INTO call_proposals
           (id, call_id, target, person_id, field, before_value, after_value, kind, evidence,
            decision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)",
        params![
            id,
            call_id,
            new.target.as_str(),
            new.person_id,
            field,
            new.before,
            after,
            new.kind.as_str(),
            Json(serde_json::to_value(&new.evidence)?),
            now_ms()
        ],
    )?;
    get(connection, &id)
}

/// A rebuild (decision 5): deletes the call's pending proposals and adds
/// the new ones; accepted and rejected ones stay. Returns every proposal
/// of the call. Atomic: on an error nothing changes. `NotFound` / `Invalid`
/// as [`insert`].
pub fn replace_pending(
    connection: &Connection,
    call_id: &str,
    new: &[NewProposal],
) -> CommandResult<Vec<Proposal>> {
    calls::project_of(connection, call_id)?;
    super::call_state::in_savepoint(connection, || {
        connection.execute(
            "DELETE FROM call_proposals WHERE call_id = ?1 AND decision = 'pending'",
            [call_id],
        )?;
        for proposal in new {
            insert(connection, call_id, proposal)?;
        }
        list(connection, call_id)
    })
}

/// Stores a decision as given: the decision, the edited text and what was
/// applied replace the stored ones; `decidedAt` is now, or cleared for
/// `pending` (an undo). It checks nothing about the data: applying and
/// undoing are the caller's. `NotFound` for an unknown proposal, `Invalid`
/// for a blank edited text.
pub fn set_decision(
    connection: &Connection,
    id: &str,
    change: &DecisionChange,
) -> CommandResult<Proposal> {
    let edited = change
        .edited
        .as_deref()
        .map(|text| required(text, "Исправленное значение не может быть пустым"))
        .transpose()?;
    let applied = change
        .applied
        .as_ref()
        .map(serde_json::to_value)
        .transpose()?
        .map(Json);
    let now = now_ms();
    let decided_at = (change.decision != ProposalDecision::Pending).then_some(now);
    let updated = connection.execute(
        "UPDATE call_proposals
            SET decision = ?2, edited = ?3, applied = ?4, decided_at = ?5,
                updated_at = MAX(?6, updated_at + 1)
          WHERE id = ?1",
        params![
            id,
            change.decision.as_str(),
            edited,
            applied,
            decided_at,
            now
        ],
    )?;
    if updated == 0 {
        return Err(CommandError::not_found(format!(
            "Предложение {id} не найдено"
        )));
    }
    get(connection, id)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::{
        calls::{CallCreate, CallStatus},
        open_in_memory,
        people::PersonCreate,
        projects::{self, ProjectCreate},
    };

    fn project(connection: &Connection, name: &str) -> String {
        let input = ProjectCreate {
            name: name.to_owned(),
            ..ProjectCreate::default()
        };
        projects::create(connection, input).unwrap().0.id
    }

    fn person(connection: &Connection, project_id: &str, name: &str) -> String {
        let input = PersonCreate {
            project_id: project_id.to_owned(),
            name: name.to_owned(),
            ..PersonCreate::default()
        };
        people::create(connection, input).unwrap().0.id
    }

    fn call(connection: &Connection, project_id: Option<&str>) -> String {
        let input = CallCreate {
            project_id: project_id.map(str::to_owned),
            status: Some(CallStatus::Finished),
            ..CallCreate::default()
        };
        calls::create(connection, input).unwrap().0.id
    }

    fn proposal(target: ProposalTarget, person_id: Option<&str>) -> NewProposal {
        NewProposal {
            target,
            person_id: person_id.map(str::to_owned),
            field: "tech".to_owned(),
            before: Some("3".to_owned()),
            after: "4".to_owned(),
            kind: ProposalKind::Said,
            evidence: vec![CallEvidence {
                recording_id: "r".to_owned(),
                segment_id: "s".to_owned(),
                start_ms: 1_000,
                quote: "пишу на Rust".to_owned(),
            }],
        }
    }

    fn invalid(result: CommandResult<Proposal>) {
        let error = result.unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    }

    #[test]
    fn inserts_reads_and_lists_proposals() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let igor = person(&connection, &acme, "Игорь");
        let first = call(&connection, Some(&acme));
        let second = call(&connection, Some(&acme));

        let new = proposal(ProposalTarget::Person, Some(&igor));
        let older = insert(&connection, &first, &new).unwrap();
        assert!(uuid::Uuid::parse_str(&older.id).is_ok_and(|id| id.get_version_num() == 7));
        assert_eq!(older.call_id, first);
        assert_eq!(older.person_id.as_deref(), Some(igor.as_str()));
        assert_eq!(
            (older.before.as_deref(), older.after.as_str()),
            (Some("3"), "4")
        );
        assert_eq!(older.evidence, new.evidence);
        assert_eq!(older.decision, ProposalDecision::Pending);
        assert_eq!((older.edited.clone(), older.applied.clone()), (None, None));
        assert_eq!(older.decided_at, None);
        assert_eq!(get(&connection, &older.id).unwrap(), older);

        let on_brief = insert(&connection, &first, &proposal(ProposalTarget::Brief, None)).unwrap();
        let newer = insert(&connection, &second, &new).unwrap();
        assert_eq!(
            list(&connection, &first).unwrap(),
            vec![older.clone(), on_brief]
        );
        let pending = pending_for_person(&connection, &igor).unwrap();
        assert_eq!(pending, vec![newer.clone(), older.clone()], "newest first");

        let error = list(&connection, "nope").unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
        let error = get(&connection, "nope").unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    }

    /// `knowledge-proposals`: no proposals for a call without a project, and
    /// a proposal is about a person of the call's project.
    #[test]
    fn refuses_proposals_that_do_not_fit_the_call() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let globex = project(&connection, "Globex");
        let igor = person(&connection, &acme, "Игорь");
        let marina = person(&connection, &globex, "Марина");
        let id = call(&connection, Some(&acme));
        let loose = call(&connection, None);

        invalid(insert(
            &connection,
            &loose,
            &proposal(ProposalTarget::Brief, None),
        ));
        invalid(insert(
            &connection,
            &id,
            &proposal(ProposalTarget::Person, Some(&marina)),
        ));
        invalid(insert(
            &connection,
            &id,
            &proposal(ProposalTarget::Person, None),
        ));
        invalid(insert(
            &connection,
            &id,
            &proposal(ProposalTarget::Brief, Some(&igor)),
        ));
        let blank = NewProposal {
            after: " ".to_owned(),
            ..proposal(ProposalTarget::Brief, None)
        };
        invalid(insert(&connection, &id, &blank));
        let error = insert(
            &connection,
            &id,
            &proposal(ProposalTarget::Person, Some("nope")),
        )
        .unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
        assert!(list(&connection, &id).unwrap().is_empty());
    }

    #[test]
    fn stores_a_decision_and_its_undo() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let igor = person(&connection, &acme, "Игорь");
        let id = call(&connection, Some(&acme));
        let made = insert(
            &connection,
            &id,
            &proposal(ProposalTarget::Person, Some(&igor)),
        )
        .unwrap();

        let applied = ProposalApplied {
            written: json!(5),
            previous: Some(json!(3)),
            section_added: false,
        };
        let accept = DecisionChange {
            decision: ProposalDecision::Accepted,
            edited: Some(" 5 ".to_owned()),
            applied: Some(applied.clone()),
        };
        let accepted = set_decision(&connection, &made.id, &accept).unwrap();
        assert_eq!(accepted.decision, ProposalDecision::Accepted);
        assert_eq!(accepted.edited.as_deref(), Some("5"));
        assert_eq!(accepted.applied, Some(applied));
        assert!(accepted.decided_at.is_some());
        assert!(accepted.updated_at > made.updated_at);
        assert!(pending_for_person(&connection, &igor).unwrap().is_empty());

        let undo = DecisionChange {
            decision: ProposalDecision::Pending,
            edited: None,
            applied: None,
        };
        let pending = set_decision(&connection, &made.id, &undo).unwrap();
        assert_eq!(pending.decision, ProposalDecision::Pending);
        assert_eq!(
            (pending.edited, pending.applied, pending.decided_at),
            (None, None, None)
        );
        assert_eq!(pending_for_person(&connection, &igor).unwrap().len(), 1);

        let blank = DecisionChange {
            edited: Some(String::new()),
            ..accept
        };
        let error = set_decision(&connection, &made.id, &blank).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
        let error = set_decision(&connection, "nope", &undo).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    }
}
