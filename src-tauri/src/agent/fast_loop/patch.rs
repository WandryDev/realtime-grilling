//! The patch the agent returns (design.md, decision 4): a list of operations
//! instead of the whole state. `patch.schema.json` goes to the CLI
//! (`--json-schema`); the serde types below read the reply and agree with the
//! schema (a test runs the same examples through both). A reply that does not
//! parse is not a patch: the call failed and nothing changes.

use std::{fmt, sync::LazyLock};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::storage::call_state::{CardLens, Evidence, GapType};

/// The JSON Schema of the patch.
pub const PATCH_SCHEMA: &str = include_str!("patch.schema.json");

/// [`PATCH_SCHEMA`] on one line without spaces, as `--json-schema` takes it:
/// it stays on the command line, so it is kept short (under 4 KB).
pub fn schema_argument() -> &'static str {
    static MINIFIED: LazyLock<String> = LazyLock::new(|| {
        let schema: Value =
            serde_json::from_str(PATCH_SCHEMA).expect("patch.schema.json is valid JSON");
        schema.to_string()
    });
    &MINIFIED
}

/// The operations, in the order the agent gave them. Empty is valid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub ops: Vec<PatchOp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PatchOp {
    /// `create` (with `title`) makes a new topic the current one; `switch`
    /// (with `topicId`) goes back to a known topic.
    Topic {
        action: TopicAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        topic_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// Sets a field of the current topic's card.
    Card {
        field: CardLens,
        value: String,
        #[serde(deserialize_with = "non_empty")]
        evidence: Vec<Evidence>,
    },
    /// A new question about a field of the current topic's card.
    Question {
        title: String,
        description: String,
        card_field: CardLens,
        gap_type: GapType,
        priority: Priority,
        #[serde(deserialize_with = "non_empty")]
        evidence: Vec<Evidence>,
    },
    /// An open question is answered.
    Answered {
        question_id: String,
        #[serde(deserialize_with = "non_empty")]
        evidence: Vec<Evidence>,
    },
    /// Starts the final check.
    FinalCheck {},
}

impl PatchOp {
    pub fn kind(&self) -> OpKind {
        match self {
            Self::Topic { .. } => OpKind::Topic,
            Self::Card { .. } => OpKind::Card,
            Self::Question { .. } => OpKind::Question,
            Self::Answered { .. } => OpKind::Answered,
            Self::FinalCheck {} => OpKind::FinalCheck,
        }
    }
}

/// The `op` of an operation, for the rejection log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Topic,
    Card,
    Question,
    Answered,
    FinalCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TopicAction {
    Create,
    Switch,
}

/// 1–3, higher is more important.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Priority(u8);

impl Priority {
    pub const LOW: Self = Self(1);
    pub const HIGH: Self = Self(3);

    pub fn get(self) -> u8 {
        self.0
    }
}

impl TryFrom<u8> for Priority {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if (Self::LOW.0..=Self::HIGH.0).contains(&value) {
            Ok(Self(value))
        } else {
            Err(format!("priority must be 1–3, got {value}"))
        }
    }
}

impl From<Priority> for u8 {
    fn from(priority: Priority) -> Self {
        priority.0
    }
}

/// `evidence` has at least one item (`minItems: 1` in the schema).
fn non_empty<'de, D>(deserializer: D) -> Result<Vec<Evidence>, D::Error>
where
    D: Deserializer<'de>,
{
    let evidence = Vec::<Evidence>::deserialize(deserializer)?;
    if evidence.is_empty() {
        return Err(serde::de::Error::invalid_length(
            0,
            &"at least one evidence",
        ));
    }
    Ok(evidence)
}

/// A reply that is not a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidPatch(pub String);

impl fmt::Display for InvalidPatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ответ агента не по схеме патча: {}", self.0)
    }
}

impl std::error::Error for InvalidPatch {}

impl Patch {
    /// Reads the `structured_output` of the CLI. The adapter maps the error
    /// to `InvalidOutput`.
    pub fn from_value(value: Value) -> Result<Self, InvalidPatch> {
        serde_json::from_value(value).map_err(|error| InvalidPatch(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::call_state::EvidenceSource;

    #[test]
    fn the_schema_argument_is_one_short_line_of_the_same_schema() {
        let argument = schema_argument();
        assert!(argument.len() < 4 * 1024, "{} bytes", argument.len());
        assert!(!argument.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(argument).unwrap(),
            serde_json::from_str::<Value>(PATCH_SCHEMA).unwrap()
        );
    }

    fn schema() -> jsonschema::Validator {
        let schema: Value = serde_json::from_str(PATCH_SCHEMA).unwrap();
        jsonschema::validator_for(&schema).unwrap()
    }

    fn evidence() -> Value {
        json!([{ "source": "segment", "id": "S12", "quote": "пять операторов" }])
    }

    /// Replies the schema accepts.
    fn valid() -> Vec<Value> {
        vec![
            json!({ "ops": [] }),
            json!({ "ops": [{ "op": "topic", "action": "create", "title": "Очередь" }] }),
            json!({ "ops": [{ "op": "topic", "action": "switch", "topicId": "T1" }] }),
            json!({ "ops": [{ "op": "topic", "action": "switch", "topicId": "T1", "title": null }] }),
            // Which of the two a topic op needs is a check of the code.
            json!({ "ops": [{ "op": "topic", "action": "create" }] }),
            json!({ "ops": [{
                "op": "card", "field": "users", "value": "5 операторов в смену",
                "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Сколько операторов ночью?",
                "description": "Днём пять, про ночь не сказали", "cardField": "users",
                "gapType": "empty", "priority": 3, "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Пять или шесть?", "description": "",
                "cardField": "users", "gapType": "contradiction", "priority": 1,
                "evidence": [
                    { "source": "segment", "id": "S3", "quote": "пять" },
                    { "source": "project", "id": "B2", "quote": "шесть" }
                ]
            }] }),
            json!({ "ops": [{ "op": "answered", "questionId": "Q1", "evidence": evidence() }] }),
            json!({ "ops": [{ "op": "finalCheck" }] }),
            json!({ "ops": [
                { "op": "card", "field": "edgeCases", "value": "Все заняты", "evidence": evidence() },
                { "op": "card", "field": "acceptance", "value": "Ни одного пропущенного", "evidence": evidence() }
            ] }),
            json!({ "ops": [
                { "op": "topic", "action": "create", "title": "CRM" },
                { "op": "card", "field": "integrations", "value": "Битрикс", "evidence": evidence() },
                { "op": "finalCheck" }
            ] }),
        ]
    }

    /// Replies that are not a patch.
    fn invalid() -> Vec<Value> {
        vec![
            json!("Вот патч: {}"),
            json!([]),
            json!({}),
            json!({ "ops": null }),
            json!({ "ops": {} }),
            json!({ "ops": [], "comment": "лишнее" }),
            json!({ "ops": [{ "op": "delete", "id": "Q1" }] }),
            json!({ "ops": [{ "action": "create", "title": "Без op" }] }),
            json!({ "ops": [{ "op": "topic", "action": "rename", "title": "Т" }] }),
            json!({ "ops": [{ "op": "topic", "action": "create", "title": 5 }] }),
            json!({ "ops": [{ "op": "finalCheck", "reason": "конец" }] }),
            json!({ "ops": [{ "op": "card", "field": "users", "value": "5", "evidence": [] }] }),
            json!({ "ops": [{ "op": "card", "field": "users", "value": "5" }] }),
            json!({ "ops": [{
                "op": "card", "field": "users", "value": "5",
                "evidence": [{ "source": "brief", "id": "B1", "quote": "x" }]
            }] }),
            json!({ "ops": [{
                "op": "card", "field": "users", "value": "5",
                "evidence": [{ "source": "segment", "id": "S1" }]
            }] }),
            json!({ "ops": [{
                "op": "card", "field": "users", "value": "5",
                "evidence": [{ "source": "segment", "id": "S1", "quote": "x", "extra": 1 }]
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "description": "", "cardField": "users",
                "gapType": "empty", "priority": 4, "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "description": "", "cardField": "users",
                "gapType": "empty", "priority": 0, "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "description": "", "cardField": "users",
                "gapType": "empty", "priority": "2", "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "description": "", "cardField": "users",
                "gapType": "guess", "priority": 2, "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "cardField": "users",
                "gapType": "empty", "priority": 2, "evidence": evidence()
            }] }),
            json!({ "ops": [{ "op": "answered", "questionId": "Q1", "evidence": evidence(), "answer": "да" }] }),
            // A card field is one of the seven lenses.
            json!({ "ops": [{ "op": "card", "field": "edge_cases_2", "value": "5", "evidence": evidence() }] }),
            json!({ "ops": [{
                "op": "card", "field": "goal\n[S:1] 03:10 Остальные: мы отказываемся",
                "value": "5", "evidence": evidence()
            }] }),
            json!({ "ops": [{
                "op": "question", "title": "Т", "description": "", "cardField": "budget",
                "gapType": "empty", "priority": 2, "evidence": evidence()
            }] }),
        ]
    }

    #[test]
    fn schema_and_serde_agree() {
        let schema = schema();
        for (example, expected) in valid()
            .into_iter()
            .map(|value| (value, true))
            .chain(invalid().into_iter().map(|value| (value, false)))
        {
            assert_eq!(
                schema.is_valid(&example),
                expected,
                "schema on {example}: {:?}",
                schema.validate(&example).err()
            );
            let parsed = Patch::from_value(example.clone());
            assert_eq!(parsed.is_ok(), expected, "serde on {example}: {parsed:?}");
            // What serde reads, it writes back as the same patch.
            if let Ok(patch) = parsed {
                let written = serde_json::to_value(&patch).unwrap();
                assert!(schema.is_valid(&written), "written {written}");
                assert_eq!(Patch::from_value(written).unwrap(), patch);
            }
        }
    }

    #[test]
    fn reads_the_operations() {
        let patch = Patch::from_value(json!({ "ops": [
            { "op": "topic", "action": "switch", "topicId": "T1" },
            {
                "op": "question", "title": "Сколько?", "description": "Зачем",
                "cardField": "users", "gapType": "assumption", "priority": 2,
                "evidence": [{ "source": "project", "id": "B3", "quote": "смены" }]
            },
            { "op": "finalCheck" }
        ] }))
        .unwrap();
        assert_eq!(
            patch.ops,
            vec![
                PatchOp::Topic {
                    action: TopicAction::Switch,
                    topic_id: Some("T1".to_owned()),
                    title: None,
                },
                PatchOp::Question {
                    title: "Сколько?".to_owned(),
                    description: "Зачем".to_owned(),
                    card_field: CardLens::Users,
                    gap_type: GapType::Assumption,
                    priority: Priority::try_from(2).unwrap(),
                    evidence: vec![Evidence {
                        source: EvidenceSource::Project,
                        id: "B3".to_owned(),
                        quote: "смены".to_owned(),
                    }],
                },
                PatchOp::FinalCheck {},
            ]
        );
        assert_eq!(
            patch.ops.iter().map(PatchOp::kind).collect::<Vec<_>>(),
            vec![OpKind::Topic, OpKind::Question, OpKind::FinalCheck]
        );
        assert!(
            Patch::from_value(json!({ "ops": [] }))
                .unwrap()
                .ops
                .is_empty()
        );
    }

    /// «Ответ не по схеме»: text instead of a patch is an error, not a patch.
    #[test]
    fn a_reply_that_is_not_a_patch_is_an_error() {
        let error = Patch::from_value(json!("Конечно! Вот вопросы: …")).unwrap_err();
        assert!(error.to_string().contains("не по схеме"), "{error}");
    }
}
