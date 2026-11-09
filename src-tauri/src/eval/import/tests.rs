//! `grill-eval import` without ffmpeg and Whisper: the tracks come from
//! the WAV fixtures through a fake [`Decoder`], the recognizer is the
//! scripted one of the speech tests, the VAD is the real Silero model of
//! the source tree, and a mono recording is labeled by a fake `claude`
//! script (in the manner of `summary/fake_cli_tests.rs`).

use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};

use super::{
    decode::{Decoder, Pick},
    label,
    passes::{self, Heard, Speech, Track, Tracks},
    *,
};
use crate::{
    agent::claude_cli::{Agent, ClaudeCodeCli},
    speech::{
        recognizer::Decode,
        testing::{Script, segment},
    },
    vad::{
        SAMPLES_PER_MS,
        detector::test_audio::{fixture, read_wav},
        dev_model_path,
    },
};

/// `two-phrases.wav`: speech at 800–4861 and 5861–8215 ms.
const PHRASES_MS: [(i64, i64); 2] = [(800, 4_861), (5_861, 8_215)];
/// Where «да» starts on the right channel of the stereo recording.
const DA_AT_MS: i64 = 9_500;
/// The VAD pads a phrase with 100 ms; its windows add some more.
const SLACK_MS: i64 = 250;

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn silence(ms: i64) -> Vec<f32> {
    vec![0.0; usize::try_from(ms).unwrap() * SAMPLES_PER_MS as usize]
}

/// `samples` padded with silence to `len`.
fn padded(mut samples: Vec<f32>, len: usize) -> Vec<f32> {
    samples.resize(len, 0.0);
    samples
}

/// Files decoded to fixed channels; `decode` mixes or picks as ffmpeg's
/// `-ac 1` and `pan` would.
#[derive(Default)]
struct FakeDecoder(HashMap<PathBuf, Vec<Vec<f32>>>);

impl FakeDecoder {
    fn with(mut self, path: &Path, channels: Vec<Vec<f32>>) -> Self {
        self.0.insert(path.to_owned(), channels);
        self
    }

    fn file(&self, path: &Path) -> Result<&Vec<Vec<f32>>, String> {
        self.0
            .get(path)
            .ok_or_else(|| format!("no fake audio for {}", path.display()))
    }
}

impl Decoder for FakeDecoder {
    fn channels(&self, path: &Path) -> Result<u16, String> {
        Ok(u16::try_from(self.file(path)?.len()).unwrap())
    }

    fn decode(&self, path: &Path, pick: Pick) -> Result<Vec<f32>, String> {
        let channels = self.file(path)?;
        Ok(match pick {
            Pick::Channel(index) => channels[usize::from(index)].clone(),
            Pick::Mix => (0..channels[0].len())
                .map(|at| channels.iter().map(|channel| channel[at]).sum::<f32>())
                .map(|sum| sum / channels.len() as f32)
                .collect(),
        })
    }
}

/// Says which pass asked and how long the phrase is, so every phrase has
/// its own text (the filters drop a repeat of a neighbour).
fn script() -> Arc<Script> {
    Script::new(|samples, params| {
        let pass = match params.decode {
            Decode::Greedy => "живая",
            Decode::Beam5 => "уточнённая",
        };
        let ms = samples.len() / SAMPLES_PER_MS as usize;
        Ok(vec![segment(&format!("{pass} фраза {ms} мс"))])
    })
}

fn speech(script: &Arc<Script>) -> Speech {
    Speech {
        recognizer: script.recognizer(),
        model: ModelId::Turbo,
        vad_model: dev_model_path(),
    }
}

/// A folder with the input files (their bytes are only copied) and the
/// `.grill-eval` of the run.
struct Setup {
    dir: tempfile::TempDir,
}

impl Setup {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn file(&self, name: &str, text: &str) -> PathBuf {
        let path = self.dir.path().join("input").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    fn eval_dir(&self) -> PathBuf {
        self.dir.path().join(".grill-eval")
    }

    fn work_dir(&self) -> PathBuf {
        self.dir.path().join("work")
    }

    fn options(&self, audio: &str) -> Options {
        Options {
            audio: self.file(audio, "audio bytes"),
            project: self.file(
                "telemedia.md",
                "# Телемедиа\n\nЕдиная система приёма звонков для сети клиник.\n",
            ),
            ..Options::default()
        }
    }

    fn import(
        &self,
        options: &Options,
        decoder: &dyn Decoder,
        script: &Arc<Script>,
        agent: Option<Arc<dyn Agent>>,
    ) -> Result<Imported, String> {
        let layout = layout(options, decoder)?;
        let tracks = decode(options, layout, decoder)?;
        block_on(run(
            options,
            layout,
            &tracks,
            &speech(script),
            agent,
            &self.eval_dir(),
            &self.work_dir(),
        ))
    }
}

fn of(corpus: &Corpus, channel: TranscriptChannel) -> Vec<&Segment> {
    corpus
        .live
        .iter()
        .filter(|segment| segment.channel == channel)
        .collect()
}

fn assert_near(actual: i64, expected: i64, what: &str) {
    assert!(
        (actual - expected).abs() <= SLACK_MS,
        "{what}: {actual} ms, expected {expected} ± {SLACK_MS} ms"
    );
}

/// The left channel: two phrases; the right: silence, then «да».
fn zoom_stereo() -> Vec<Vec<f32>> {
    let phrases = read_wav(&fixture("two-phrases.wav"));
    let mut da = silence(DA_AT_MS);
    da.extend(read_wav(&fixture("da.wav")));
    let len = phrases.len().max(da.len());
    vec![padded(phrases, len), padded(da, len)]
}

/// «Стерео-запись Zoom»: the left channel is «Я», the right «Остальные»,
/// the times from the start of the recording; both passes, the glossary of
/// the project, the audio copied.
#[test]
fn a_stereo_zoom_recording_keeps_its_sides() {
    let setup = Setup::new();
    let mut options = setup.options("zoom.m4a");
    options.channels = Some(Layout::LeftMe);
    options.people = Some(setup.file(
        "people.json",
        r#"[{ "name": "Ольга Демченко", "role": "Главный врач", "profile": { "tech": 1 } },
            { "name": "Игорь Савчук", "role": "IT" }]"#,
    ));
    let decoder = FakeDecoder::default().with(&options.audio, zoom_stereo());
    let script = script();

    let imported = setup.import(&options, &decoder, &script, None).unwrap();
    let corpus = Corpus::load(&imported.path).unwrap();

    assert_eq!(imported.path, setup.eval_dir().join("corpus/zoom.json"));
    assert_eq!(corpus.channels, Channels::Real);
    let me = of(&corpus, TranscriptChannel::Me);
    assert_eq!(me.len(), 2, "{:?}", corpus.live);
    for (segment, (start, end)) in me.iter().zip(PHRASES_MS) {
        assert_near(segment.start_ms, start, "start of «Я»");
        assert_near(segment.end_ms, end, "end of «Я»");
        assert!(segment.text.starts_with("живая фраза"), "{}", segment.text);
    }
    let others = of(&corpus, TranscriptChannel::Others);
    assert_eq!(others.len(), 1, "{:?}", corpus.live);
    let da_ms = i64::try_from(read_wav(&fixture("da.wav")).len() as u64 / SAMPLES_PER_MS).unwrap();
    assert!(
        others[0].start_ms >= DA_AT_MS && others[0].end_ms <= DA_AT_MS + da_ms,
        "«да» at {}–{} ms, the file has it in {DA_AT_MS}–{} ms",
        others[0].start_ms,
        others[0].end_ms,
        DA_AT_MS + da_ms
    );
    assert!(
        corpus
            .live
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms)
    );

    let refined = corpus.refined.as_ref().unwrap();
    assert_eq!(refined.len(), 3, "{refined:?}");
    assert!(
        refined
            .iter()
            .all(|segment| segment.text.starts_with("уточнённая фраза"))
    );
    assert_eq!(
        refined
            .iter()
            .filter(|segment| segment.channel == TranscriptChannel::Me)
            .count(),
        2
    );

    // The glossary is the app's: the project and its people, in both
    // prompts.
    assert!(
        corpus.glossary.starts_with("Телемедиа"),
        "{}",
        corpus.glossary
    );
    assert!(corpus.glossary.contains("Ольга Демченко"));
    let prompts = script.prompts.lock().unwrap().clone();
    assert!(prompts.iter().all(|prompt| prompt.contains("Телемедиа")));
    assert_eq!(corpus.people.len(), 2);
    assert_eq!(corpus.participant_ids.len(), 2);
    assert_eq!(corpus.people[0].profile["tech"], 1);
    assert_eq!(corpus.people[1].profile, json!({}));

    assert!(matches!(
        &corpus.origin,
        Origin::Import { layout: Layout::LeftMe, files, model, .. }
            if files == &["zoom.m4a"] && model == "turbo"
    ));
    assert!(setup.eval_dir().join("audio/zoom/zoom.m4a").is_file());
    let duration = i64::try_from(zoom_stereo()[0].len() as u64 / SAMPLES_PER_MS).unwrap();
    assert_eq!(corpus.recording.duration_ms, duration);
    assert!(corpus.original.is_none());
}

/// `right=me` swaps the sides; two files take one track each.
#[test]
fn the_layout_picks_the_tracks() {
    let setup = Setup::new();
    let mut options = setup.options("call.wav");
    let stereo = vec![vec![0.1; 4], vec![0.3; 4]];
    let decoder = FakeDecoder::default().with(&options.audio, stereo);

    assert!(
        layout(&options, &decoder)
            .unwrap_err()
            .contains("--channels")
    );
    options.channels = Some(Layout::RightMe);
    let tracks = decode(&options, layout(&options, &decoder).unwrap(), &decoder).unwrap();
    assert_eq!(
        tracks,
        Tracks::Split {
            me: vec![0.3; 4],
            others: vec![0.1; 4]
        }
    );
    options.channels = Some(Layout::Mono);
    let tracks = decode(&options, layout(&options, &decoder).unwrap(), &decoder).unwrap();
    assert_eq!(tracks, Tracks::Mixed(vec![0.2; 4]));

    let mono = setup.options("phone.mp3");
    let decoder = FakeDecoder::default().with(&mono.audio, vec![vec![0.0; 4]]);
    assert_eq!(layout(&mono, &decoder).unwrap(), Layout::Mono);
    let mut wrong = mono.clone();
    wrong.channels = Some(Layout::LeftMe);
    assert!(layout(&wrong, &decoder).unwrap_err().contains("моно"));

    let mut two = setup.options("me.ogg");
    two.others = Some(setup.file("others.ogg", "x"));
    assert_eq!(layout(&two, &decoder).unwrap(), Layout::TwoFiles);
    two.channels = Some(Layout::LeftMe);
    assert!(layout(&two, &decoder).is_err());
}

/// «Проект только с описанием»: the project is the description and
/// nothing else; two files give the channels.
#[test]
fn a_project_with_a_description_only() {
    let setup = Setup::new();
    let mut options = setup.options("me.ogg");
    options.others = Some(setup.file("others.ogg", "other bytes"));
    options.name = Some("telemedia-1".to_owned());
    let decoder = FakeDecoder::default()
        .with(&options.audio, vec![read_wav(&fixture("da.wav"))])
        .with(
            options.others.as_ref().unwrap(),
            vec![read_wav(&fixture("two-phrases.wav"))],
        );

    let imported = setup.import(&options, &decoder, &script(), None).unwrap();
    let corpus = Corpus::load(&imported.path).unwrap();

    let project = corpus.project.as_ref().unwrap();
    assert_eq!(project.name, "Телемедиа");
    assert_eq!(
        project.description,
        "# Телемедиа\n\nЕдиная система приёма звонков для сети клиник."
    );
    assert!(project.sources.is_empty());
    assert!(project.brief.is_none());
    assert_eq!(project.notes, "");
    assert!(corpus.people.is_empty());
    assert_eq!(corpus.glossary, "Телемедиа");
    assert_eq!(of(&corpus, TranscriptChannel::Me).len(), 1);
    assert_eq!(of(&corpus, TranscriptChannel::Others).len(), 2);
    assert!(matches!(
        &corpus.origin,
        Origin::Import { layout: Layout::TwoFiles, files, .. }
            if files == &["me.ogg", "others.ogg"]
    ));
    assert!(
        setup
            .eval_dir()
            .join("audio/telemedia-1/others.ogg")
            .is_file()
    );
}

#[test]
fn documents_are_read_as_the_apps_sources() {
    let setup = Setup::new();
    let mut options = setup.options("me.ogg");
    options.others = Some(setup.file("others.ogg", "x"));
    options.docs = vec![setup.file("tz.md", "# ТЗ\n\nПриём звонков ночью.\r\n")];
    options.project = setup.file("project.md", "Описание без заголовка");
    options.name = Some("tz".to_owned());
    let decoder = FakeDecoder::default()
        .with(&options.audio, vec![read_wav(&fixture("da.wav"))])
        .with(options.others.as_ref().unwrap(), vec![silence(500)]);

    let corpus = setup
        .import(&options, &decoder, &script(), None)
        .unwrap()
        .corpus;

    let project = corpus.project.unwrap();
    assert_eq!(project.name, "tz");
    assert_eq!(project.sources.len(), 1);
    assert_eq!(project.sources[0].name, "tz.md");
    assert_eq!(project.sources[0].text, "# ТЗ\n\nПриём звонков ночью.");

    options.docs = vec![setup.file("tz.odt", "x")];
    let error = setup
        .import(&options, &decoder, &script(), None)
        .unwrap_err();
    assert!(error.contains(".docx"), "{error}");
}

/// A recording where the VAD finds nothing has nothing to replay: an
/// error, and nothing is written.
#[test]
fn a_silent_recording_is_not_imported() {
    let setup = Setup::new();
    let mut options = setup.options("silence.wav");
    options.channels = Some(Layout::LeftMe);
    let decoder = FakeDecoder::default().with(&options.audio, vec![silence(2_000), silence(2_000)]);
    let error = setup
        .import(&options, &decoder, &script(), None)
        .unwrap_err();
    assert!(error.contains("ни одной фразы"), "{error}");
    assert!(!setup.eval_dir().exists());
}

/// A mono recording comes out of both passes as one mixed track, before
/// any labeling.
#[test]
fn a_mono_recording_is_mixed_before_labeling() {
    let setup = Setup::new();
    let skeleton_options = setup.options("phone.mp3");
    let tracks = Tracks::Mixed(read_wav(&fixture("two-phrases.wav")));
    let corpus = Corpus {
        version: corpus::FORMAT,
        name: "phone".to_owned(),
        origin: Origin::Import {
            files: Vec::new(),
            layout: Layout::Mono,
            model: "turbo".to_owned(),
            imported_at: 1_000,
        },
        channels: Channels::Approximate,
        project: None,
        people: Vec::new(),
        participant_ids: Vec::new(),
        glossary: String::new(),
        settings: skeleton_options.settings,
        recording: Recording {
            started_at: 1_000,
            duration_ms: tracks.duration_ms(),
        },
        live: Vec::new(),
        refined: None,
        original: None,
    };

    let transcribed = block_on(passes::transcribe(
        &corpus,
        &tracks,
        &speech(&script()),
        &setup.work_dir(),
        false,
    ))
    .unwrap();

    assert_eq!(transcribed.live.len(), 2);
    assert_eq!(transcribed.refined.len(), 2);
    assert!(
        transcribed
            .live
            .iter()
            .chain(&transcribed.refined)
            .all(|phrase| phrase.track == Track::Mixed)
    );
}

/* Mono labeling against a fake `claude` */

/// Records its arguments and stdin, then plays `events.jsonl`.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
cat > "$STATE/stdin"
cat "$STATE/events.jsonl"
"#;

/// The CLI's output of a call that wrote `output` through
/// `StructuredOutput`.
fn events(output: &Value) -> String {
    [
        json!({ "type": "system", "subtype": "init", "model": "claude-sonnet-5-5" }),
        json!({
            "type": "result", "subtype": "success", "is_error": false,
            "structured_output": output,
            "total_cost_usd": 0.03,
            "usage": { "input_tokens": 3_000, "output_tokens": 200 }
        }),
    ]
    .iter()
    .map(|line| format!("{line}\n"))
    .collect()
}

struct FakeCli {
    dir: tempfile::TempDir,
}

impl FakeCli {
    fn replying(output: &Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("events.jsonl"), events(output)).unwrap();
        Self { dir }
    }

    fn agent(&self) -> Arc<dyn Agent> {
        let cli = self.dir.path().join("bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        let body = FAKE_CLAUDE.replace("@STATE@", &self.dir.path().display().to_string());
        fs::write(&cli, body).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        Arc::new(ClaudeCodeCli::new(cli, self.dir.path().join("work")))
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.dir.path().join(name)).unwrap_or_default()
    }

    fn args(&self) -> Vec<String> {
        self.read("args")
            .split('\0')
            .filter(|arg| !arg.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

fn phone(setup: &Setup) -> (Options, FakeDecoder) {
    let mut options = setup.options("phone.mp3");
    options.manager = Some("Дмитрий".to_owned());
    let decoder =
        FakeDecoder::default().with(&options.audio, vec![read_wav(&fixture("two-phrases.wav"))]);
    (options, decoder)
}

/// «Моно-запись телефона»: every phrase is «Я» or «Остальные» by one call
/// with the schema, and the corpus is split approximately.
#[test]
fn a_mono_phone_recording_is_labeled_by_its_text() {
    let setup = Setup::new();
    let (options, decoder) = phone(&setup);
    let cli = FakeCli::replying(&json!({ "labels": [
        { "id": "S1", "speaker": "me" },
        { "id": "S2", "speaker": "others" },
    ]}));

    let imported = setup
        .import(&options, &decoder, &script(), Some(cli.agent()))
        .unwrap();
    let corpus = Corpus::load(&imported.path).unwrap();

    assert_eq!(corpus.channels, Channels::Approximate);
    let channels: Vec<TranscriptChannel> = corpus.live.iter().map(|s| s.channel).collect();
    assert_eq!(channels, [TranscriptChannel::Me, TranscriptChannel::Others]);
    let refined: Vec<TranscriptChannel> = corpus
        .refined
        .as_ref()
        .unwrap()
        .iter()
        .map(|s| s.channel)
        .collect();
    assert_eq!(refined, channels);
    assert!(matches!(
        corpus.origin,
        Origin::Import {
            layout: Layout::Mono,
            ..
        }
    ));
    assert_eq!(imported.labeling.unwrap().cost_usd, Some(0.03));

    let args = cli.args();
    let after = |flag: &str| {
        let at = args.iter().position(|arg| arg == flag).unwrap();
        args[at + 1].clone()
    };
    assert_eq!(after("--model"), "claude-sonnet-5-5");
    assert_eq!(after("--effort"), "medium");
    assert!(after("--json-schema").contains("\"others\""));
    let stdin = cli.read("stdin");
    assert!(stdin.contains("Единая система приёма звонков"), "{stdin}");
    assert!(stdin.contains("Менеджер: Дмитрий"), "{stdin}");
    assert!(
        stdin.contains("S1 [00:00–00:04] уточнённая фраза"),
        "{stdin}"
    );
    assert!(
        stdin.contains("S2 [00:05–00:08] уточнённая фраза"),
        "{stdin}"
    );
}

/// A reply off the schema, or one that misses a phrase, fails the import:
/// no corpus, no audio.
#[test]
fn a_labeling_reply_off_the_schema_fails_the_import() {
    for reply in [
        json!({ "labels": [{ "id": "S1", "speaker": "me" }] }),
        json!({ "speakers": {} }),
    ] {
        let setup = Setup::new();
        let (options, decoder) = phone(&setup);
        let cli = FakeCli::replying(&reply);

        let error = setup
            .import(&options, &decoder, &script(), Some(cli.agent()))
            .unwrap_err();

        assert!(error.contains("Разметка моно"), "{error}");
        assert!(!setup.eval_dir().exists(), "{reply}");
    }
}

#[test]
fn a_mono_recording_needs_claude_code() {
    let setup = Setup::new();
    let (options, decoder) = phone(&setup);
    let error = setup
        .import(&options, &decoder, &script(), None)
        .unwrap_err();
    assert!(error.contains("Claude Code"), "{error}");
}

fn heard(id: &str, start_ms: i64, end_ms: i64) -> Heard {
    Heard {
        id: id.to_owned(),
        track: Track::Mixed,
        start_ms,
        end_ms,
        text: id.to_owned(),
    }
}

#[test]
fn labels_are_checked_against_the_phrases() {
    let ok = json!({ "labels": [
        { "id": "S2", "speaker": "others" },
        { "id": "S1", "speaker": "me" },
    ]});
    assert_eq!(
        label::parse(&ok, 2).unwrap(),
        [TranscriptChannel::Me, TranscriptChannel::Others]
    );
    let missing = label::parse(&json!({ "labels": [{ "id": "S1", "speaker": "me" }] }), 2);
    assert!(missing.unwrap_err().contains("пропустила 1 из 2"));
    for bad in [
        json!({ "labels": [{ "id": "S3", "speaker": "me" }] }),
        json!({ "labels": [{ "id": "S1", "speaker": "client" }] }),
        json!({ "labels": [{ "id": "S1", "speaker": "me" }, { "id": "S1", "speaker": "me" }] }),
        json!({ "labels": "S1" }),
    ] {
        assert!(
            label::parse(&bad, 1).unwrap_err().contains("не по схеме"),
            "{bad}"
        );
    }
}

/// A live phrase takes the label of the refined phrase it overlaps most,
/// or of the nearest one.
#[test]
fn live_phrases_take_the_labels_by_time() {
    let labeled = [
        (heard("a", 0, 4_000), TranscriptChannel::Me),
        (heard("b", 4_200, 9_000), TranscriptChannel::Others),
        (heard("c", 20_000, 21_000), TranscriptChannel::Me),
    ];
    let live = [
        heard("x", 100, 3_900),
        heard("y", 3_500, 8_000),
        heard("z", 12_000, 13_000),
        heard("w", 17_000, 18_000),
    ];
    assert_eq!(
        label::by_time(&live, &labeled),
        [
            TranscriptChannel::Me,
            TranscriptChannel::Others,
            TranscriptChannel::Others,
            TranscriptChannel::Me,
        ]
    );
}

#[test]
fn the_project_name_is_the_first_heading() {
    assert_eq!(project_name("Текст\n# Обменник \n## Цели", "x"), "Обменник");
    assert_eq!(project_name("## Цели\nтекст", "obmen"), "obmen");
    assert_eq!(project_name("#\n", "obmen"), "obmen");
}

#[test]
fn people_need_a_name_and_an_object_profile() {
    let setup = Setup::new();
    let bad = setup.file("bad.json", r#"[{ "role": "IT" }]"#);
    assert!(people(&bad).unwrap_err().contains("JSON-массив"));
    let bad = setup.file("bad2.json", r#"[{ "name": "Ира", "profile": 3 }]"#);
    assert!(people(&bad).unwrap_err().contains("объектом"));
}

/// The app's model if installed, the other one if only it is; without
/// either, the error says to download one in the app.
#[test]
fn the_installed_model_is_found_in_the_apps_folder() {
    let dir = tempfile::tempdir().unwrap();
    let error = installed_model(dir.path(), ModelId::Turbo).unwrap_err();
    assert!(error.contains("откройте приложение"), "{error}");

    // A sparse file of the exact size counts as installed.
    let small = models::model_file(dir.path(), ModelId::Small);
    fs::File::create(&small)
        .unwrap()
        .set_len(ModelId::Small.spec().size)
        .unwrap();
    assert_eq!(
        installed_model(dir.path(), ModelId::Turbo).unwrap(),
        (ModelId::Small, small.clone())
    );
    assert_eq!(
        installed_model(dir.path(), ModelId::Small).unwrap(),
        (ModelId::Small, small)
    );
}

#[test]
fn without_the_apps_database_the_settings_are_the_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let (settings, model) = app_settings(&dir.path().join("grill.db")).unwrap();
    assert!(settings.is_empty());
    assert_eq!(model, ModelId::Turbo);
}
