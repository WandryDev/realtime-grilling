include!("command_names.rs");

fn main() {
    println!("cargo:rerun-if-changed=command_names.rs");
    // With an app manifest every app command needs `allow-<command>` in a
    // capability (design.md, decision 7).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
