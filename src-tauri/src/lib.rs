mod agent;
mod audio;
mod bindings;
mod call;
mod commands;
mod error;
/// `grill-eval` (question-quality design.md, decision 1): its only way in
/// is `eval::cli::main`.
pub mod eval;
mod events;
mod permissions;
mod projects;
mod recording;
mod records;
mod shell;
mod speech;
mod storage;
mod summary;
mod vad;

use tauri_plugin_global_shortcut::{Shortcut, ShortcutEvent};

/// The hidden mode of the app binary that reads one PDF or DOCX in a child
/// process (`--extract-text <path> <ext>`, projects-people-brief design.md,
/// decision 2): its exit code after it printed the text, `None` for a
/// normal start.
pub fn extract_text_child() -> Option<i32> {
    projects::sources::isolated::child_main()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = bindings::builder();

    // Keep `src/bindings.ts` in step with the Rust side while developing.
    #[cfg(debug_assertions)]
    if let Err(error) = bindings::export(&builder) {
        eprintln!("grill: failed to export bindings: {error}");
    }

    let app = tauri::Builder::default()
        // First, so a second launch exits before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_entry(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([shell::AUTOSTART_ARG])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(
                    |app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent| {
                        shell::shortcuts::on_shortcut(app, shortcut, event);
                    },
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // `platform()` picks the Windows variant of the onboarding steps.
        .plugin(tauri_plugin_os::init())
        // Picking documents and the brief's export folder.
        .plugin(tauri_plugin_dialog::init())
        // A recording's channels for the main window's player
        // (`grill-audio://localhost/<id>/<me|others>`, post-call task 3.4).
        .register_asynchronous_uri_scheme_protocol(records::scheme::SCHEME, records::scheme::handle)
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            shell::setup(app)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| shell::on_run_event(app, &event));
}

#[cfg(test)]
mod tests;
