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
    link_clang_runtime();
}

/// whisper.cpp's Metal backend asks for the OS version with `@available`,
/// which compiles to a call of `__isPlatformVersionAtLeast` from clang's
/// runtime once the deployment target is below the checked version. That is
/// the bundle build: the Tauri CLI sets the target to the bundle's minimum
/// system version (14.2), and the release link then fails with the symbol
/// undefined, because rustc does not link clang's runtime. A plain
/// `cargo build` targets the host's macOS and never needs it. The archive
/// only gives the linker what is still undefined.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let resource_dir = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    let runtime = resource_dir
        .map(|dir| std::path::Path::new(&dir).join("lib/darwin/libclang_rt.osx.a"))
        .filter(|archive| archive.is_file());
    match runtime {
        Some(archive) => println!("cargo:rustc-link-arg={}", archive.display()),
        None => println!(
            "cargo:warning=clang's runtime (libclang_rt.osx.a) was not found; the bundle build may fail to link `__isPlatformVersionAtLeast`"
        ),
    }
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
