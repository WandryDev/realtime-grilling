// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--extract-text <path> <ext>`: read one PDF or DOCX in this child
    // process and exit, before anything of the app starts.
    if let Some(code) = realtime_grilling_lib::extract_text_child() {
        std::process::exit(code);
    }
    realtime_grilling_lib::run()
}
