//! `grill-eval`: replays of recorded calls through the fast loop
//! (question-quality design.md, decision 1). Everything is in the library's
//! `eval` module; this only hands it the arguments.

fn main() -> std::process::ExitCode {
    realtime_grilling_lib::eval::cli::main(std::env::args().skip(1).collect())
}
