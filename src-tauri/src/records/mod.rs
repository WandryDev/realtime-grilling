//! What a finished call keeps (post-call design.md, decisions 7–11): the
//! review of its proposals, its task cards, its transcript, questions and
//! search, and its audio.
//!
//! The data lives in `storage` (`proposals::apply`, `call_records`,
//! `call_search`); this module holds the commands.

pub mod commands;
