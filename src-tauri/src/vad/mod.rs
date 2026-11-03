//! Speech segmentation (specs/speech-segmentation, design.md decisions 16–18):
//! Silero VAD through whisper.cpp cuts each recording channel into phrases.
//!
//! - `detector`: the model and the sliding-window pass over the batch API;
//! - `segmenter`: the pure phrase state machine over window probabilities;
//! - `worker`: one thread per channel between the recorder and a `PhraseSink`.

pub mod detector;
pub mod segmenter;
pub mod worker;

use std::path::PathBuf;

/// The pipeline runs at 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;
pub const SAMPLES_PER_MS: u64 = SAMPLE_RATE as u64 / 1_000;
/// Silero scores 512-sample (32 ms) windows.
pub const WINDOW_SAMPLES: usize = 512;

/// The model inside the bundle's resources (`tauri.conf.json`).
pub const MODEL_RESOURCE: &str = "models/ggml-silero-v5.1.2.bin";

/// The model in the source tree, for `tauri dev` and the tests.
pub fn dev_model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(MODEL_RESOURCE)
}

/// Where the bundled model is. A debug build falls back to the source tree
/// when the resource is not where Tauri looks. A missing model is not an error
/// here: the worker reports segmentation as unavailable.
pub fn bundled_model_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    use tauri::Manager;
    use tauri::path::BaseDirectory;

    let resolved = app
        .path()
        .resolve(MODEL_RESOURCE, BaseDirectory::Resource)
        .ok();
    match resolved {
        Some(path) if path.is_file() => path,
        _ if cfg!(debug_assertions) => dev_model_path(),
        Some(path) => path,
        None => PathBuf::from(MODEL_RESOURCE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dev_model_is_in_the_source_tree() {
        assert!(dev_model_path().is_file(), "{}", dev_model_path().display());
    }

    #[test]
    fn bundled_path_falls_back_to_the_source_tree_in_debug() {
        let app = tauri::test::mock_app();
        let path = bundled_model_path(app.handle());
        assert!(path.ends_with(MODEL_RESOURCE), "{}", path.display());
        if cfg!(debug_assertions) {
            assert!(path.is_file(), "{}", path.display());
        }
    }
}
