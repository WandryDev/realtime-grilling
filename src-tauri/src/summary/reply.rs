//! The agent's replies as the schemas give them (`summary.schema.json` for
//! call A, `proposals.schema.json` for call B). A reply that does not read
//! as these types is "не по схеме": the stage fails (decision 4). What a
//! reply refers to is checked later (`validate.rs`).

use serde::Deserialize;
use serde_json::Value;

use crate::storage::{
    call_state::{CardLens, GapType},
    proposals::ProposalKind,
    summaries::{FactStatus, PointStatus},
};

/// `S#`, `P#` or `B#` with a quote of it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceReply {
    pub id: String,
    pub quote: String,
}

/// Call A.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryReply {
    pub title: String,
    pub tldr: String,
    pub topics: Vec<TopicReply>,
    pub answered: Vec<AnsweredReply>,
    pub next: Vec<NextReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicReply {
    /// `T#` of the fast loop it continues.
    pub refs: Vec<String>,
    pub title: String,
    /// `S#`.
    pub from: String,
    pub to: String,
    pub points: Vec<PointReply>,
    pub card: CardReply,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointReply {
    pub text: String,
    pub status: PointStatus,
    pub evidence: Vec<EvidenceReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardReply {
    pub title: String,
    pub fields: Vec<FieldReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldReply {
    pub field: CardLens,
    pub facts: Vec<FactReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactReply {
    pub text: String,
    pub status: FactStatus,
    pub evidence: Vec<EvidenceReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnsweredReply {
    /// `Q#`.
    #[serde(rename = "ref")]
    pub question: String,
    pub evidence: Vec<EvidenceReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NextReply {
    pub text: String,
    /// The position of a topic of this reply, from 1.
    pub topic: Option<i64>,
    pub field: Option<CardLens>,
    pub gap: GapType,
}

/// Call B.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalsReply {
    pub proposals: Vec<ProposalReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalReply {
    /// `brief` or `H#`.
    pub target: String,
    pub field: String,
    pub after: String,
    pub kind: ProposalKind,
    pub evidence: Vec<EvidenceReply>,
}

impl SummaryReply {
    /// `Err` with serde's reason when the reply is not one.
    pub fn from_reply(reply: Value) -> Result<Self, String> {
        serde_json::from_value(reply).map_err(|error| error.to_string())
    }
}

impl ProposalsReply {
    pub fn from_reply(reply: Value) -> Result<Self, String> {
        serde_json::from_value(reply).map_err(|error| error.to_string())
    }
}
