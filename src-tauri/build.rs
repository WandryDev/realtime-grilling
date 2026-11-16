include!("command_names.rs");

fn main() {
    println!("cargo:rerun-if-changed=command_names.rs");
    // With an app manifest every app command needs `allow-<command>` in a
    // capability (design.md, decision 7).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");
    embed_windows_manifest();
}

/// tauri-build embeds its Windows manifest (Common Controls v6) only into the
/// app binary. The test binaries link the same Tauri code and then fail to
/// start with STATUS_ENTRYPOINT_NOT_FOUND (`TaskDialogIndirect` lives in
/// v6). The linker embeds the same manifest into every binary instead.
fn embed_windows_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
