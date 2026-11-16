//! `grill-eval`: replays of recorded calls through the fast loop
//! (question-quality design.md, decision 1). Everything is in the library's
//! `eval` module; this only hands it the arguments. An example with the
//! `eval` feature, so the app's bundle never has it:
//! `bun run eval -- <подкоманда>` from the repository root.

fn main() -> std::process::ExitCode {
    // `import --docs` reads PDF and DOCX as the app does: in a child
    // process of this binary in the `--extract-text` mode.
    if let Some(code) = realtime_grilling_lib::extract_text_child() {
        return std::process::ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    realtime_grilling_lib::eval::cli::main(std::env::args().skip(1).collect())
}
