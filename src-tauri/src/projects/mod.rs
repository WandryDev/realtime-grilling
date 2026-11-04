//! Projects beyond their rows: documents and their text, what the brief is
//! built from, running brief builds (projects-people-brief).

pub mod brief;
pub mod brief_inputs;
pub mod builds;
pub mod sources;

use sha2::{Digest as _, Sha256};

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}
