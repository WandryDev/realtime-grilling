//! The subcommands of `grill-eval` and their arguments (question-quality
//! design.md, decision 1). The arguments are few, so they are read here by
//! hand: `--flag value`, `--flag=value` and switches.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    time::Duration,
};

use super::{
    brief, compare,
    corpus::{self, Corpus, Layout},
    export,
    import::{self, decode::Ffmpeg, passes::Speech},
    judge, metrics, replay,
    report::{self, Report},
};
use crate::{
    agent::{
        self, AgentState,
        claude_cli::{Agent, ClaudeCodeCli},
        discover::{self, SearchEnv},
        fast_loop::assembly,
    },
    speech::recognizer::Recognizer,
    storage::{self, transcript::TranscriptChannel},
    vad,
};

const USAGE: &str = "\
grill-eval — прогон записанных звонков через быстрый контур.

Использование: grill-eval <подкоманда> [аргументы]
Из корня репозитория: bun run eval -- <подкоманда> [аргументы]
(пример крейта src-tauri с фичей eval, в приложение не входит).

Подкоманды:
  export <id записи> [--name N] [--db ФАЙЛ] [--force]
      Запись из базы приложения (только чтение) в набор .grill-eval/corpus/<N>.json.
  import <аудио> [--others <аудио>] [--channels left=me|right=me|mono]
         --project <описание.md> [--docs <файлы>] [--people <people.json>]
         [--manager ИМЯ] [--name N] [--force]
      Внешняя запись звонка в набор: распознавание моделями приложения, аудио
      копируется в .grill-eval/audio/<N>/. Нужен ffmpeg.
  brief <набор>
      Пересобрать бриф набора нынешним промптом брифа; прежний остаётся в briefPrevious.
  replay <набор> [--from M] [--to M] [--label L] [--rules ФАЙЛ] [--realtime]
         [--baseline-state] [--no-gaps] [--quiet-minutes N]
      Прогон набора через быстрый контур с настоящим Claude Code. Отчёт —
      .grill-eval/reports/<время>-<L>-<n>/report.json и report.md.
  judge <отчёт>
      Разметка вопросов прогона LLM-судьёй: judge.json рядом с отчётом, report.md заново.
  compare <отчёт A> <отчёт B>
      Сравнение двух прогонов одного набора: таблица метрик и вопросы, которые
      появились или пропали; пишется и в compare.md в папке B.

Каталог .grill-eval/ — в корне репозитория (ближайшая папка вверх от текущей, где
есть .git), он в .gitignore. Рабочие файлы команд (промпты, аудио импорта до
сохранения набора) — в .grill-eval/tmp/. `grill-eval <подкоманда> --help` — справка
по подкоманде.
";

const EXPORT_USAGE: &str = "\
grill-eval export <id записи> [--name N] [--db ФАЙЛ] [--force]

Выгружает запись из базы приложения в набор .grill-eval/corpus/<N>.json: живую и
уточнённую расшифровку, проект с брифом и текстами документов, людей, глоссарий,
настройки быстрого контура, исходные темы, вопросы и вызовы агента.

  --name N    имя набора (по умолчанию id записи)
  --db ФАЙЛ   база приложения (по умолчанию база приложения этого пользователя)
  --force     заменить набор с тем же именем (без флага — ошибка: пересобранный
              бриф и briefPrevious пропали бы)

База открывается только на чтение и читается одной транзакцией, так что набор —
один момент записи, даже если приложение пишет. Запись без живой расшифровки —
ошибка, файл не создаётся.
";

const IMPORT_USAGE: &str = "\
grill-eval import <аудио> [--others <аудио>] [--channels left=me|right=me|mono]
                  --project <описание.md> [--docs <файлы>] [--people <people.json>]
                  [--manager ИМЯ] [--name N] [--force]

Распознаёт запись звонка, сделанную вне приложения, моделями приложения (живой
проход и второй проход) и пишет набор .grill-eval/corpus/<N>.json; аудио
копируется в .grill-eval/audio/<N>/. Аудио никуда не отправляется.

  <аудио>             запись звонка или дорожка менеджера (с --others); любой
                      формат, который читает ffmpeg
  --others ФАЙЛ       дорожка клиента: каналы «Я» и «Остальные» — по файлам
  --channels К        для одного файла: left=me или right=me (стерео, менеджер
                      слева или справа), mono (одна дорожка); моно-файл без
                      флага — mono, у стерео флаг обязателен
  --project ФАЙЛ      описание проекта в markdown; первый заголовок «# …» —
                      название проекта (иначе --name или имя файла)
  --docs ФАЙЛЫ        документы проекта (.md, .txt, .pdf, .docx), все файлы до
                      следующего флага
  --people ФАЙЛ       люди клиента: JSON-массив { name, role, profile? }
  --manager ИМЯ       имя менеджера, подсказка для разметки моно
  --name N            имя набора (по умолчанию имя аудиофайла без расширения)
  --force             заменить набор с тем же именем и его аудио (без флага —
                      ошибка до распознавания)

Моно-запись делится на «Я» и «Остальные» одним вызовом Claude Code по тексту,
набор помечается «разделено приблизительно»; расшифровка длиннее 150 тыс. символов в
один вызов не помещается — такую запись режут на части. Нужны ffmpeg и ffprobe в PATH
и модель распознавания, скачанная в приложении. Бриф набора собирает
`grill-eval brief`. Неудачный импорт ничего не оставляет.
";

const REPLAY_USAGE: &str = "\
grill-eval replay <набор> [--from M] [--to M] [--label L] [--rules ФАЙЛ] [--realtime]
                  [--baseline-state] [--no-gaps] [--quiet-minutes N]

Прогоняет набор (имя в .grill-eval/corpus/ или путь к файлу) через быстрый контур
приложения с настоящим Claude Code. Простой между фразами пропускается, во время
вызова часы идут вместе с реальным временем. Фраза подаётся в момент своего конца,
а приложение получает её на 1–3 с позже (распознавание): прогон чуть оптимистичнее.
База приложения не открывается.

  --from M, --to M  только фразы, начавшиеся с M-й по M-ю минуту
  --label L         метка отчёта (по умолчанию run)
  --rules ФАЙЛ      правила промпта из файла вместо встроенных; описание схемы
                    патча от них не зависит (это видно в заголовке отчёта)
  --realtime        на настоящих часах, без пропуска простоя
  --baseline-state  состояние вызова без строк «Пустые линзы» и «N мин без новых
                    вопросов»: базовая линия, с которой их сравнивают
  --no-gaps         бриф без пунктов «Неясно до звонка»
  --quiet-minutes N строка «N мин без новых вопросов» с N минут паузы, а не с 5
                    (подбор порога, задача 4.4)

Базовая линия до изменения question-quality (правила, состояние и бриф как раньше):
  --rules spikes/question-quality/rules-baseline.md --baseline-state --no-gaps

Отчёт: .grill-eval/reports/<время>-<L>-<n>/report.json и report.md с метриками (n —
номер, чтобы прогоны в одну секунду не совпали). Время вопроса в метриках — когда
он впервые показан; вопросы, так и не показанные (ждали за полным списком), идут
отдельным списком. Если агент недоступен (нет входа, исчерпан лимит) или прогон
упал после начала, он останавливается и отчёт сохраняется как неполный.
";

const JUDGE_USAGE: &str = "\
grill-eval judge <отчёт>

Размечает показанные вопросы прогона (папка отчёта или его report.json) LLM-судьёй:
claude-sonnet-5-5, один вызов на звонок (длинный — частями по 30 минут). Судья получает
расшифровку набора (уточнённую, если она не короче 90 % живой) на отрезке прогона и за
5 минут до него, проект с брифом и вопросы прогона со временем показа. Набор берётся
из файла, который читал прогон, а если его нет — из .grill-eval/corpus/ по имени.

Пишет judge.json рядом с отчётом и заново report.md. Ответ не по схеме или сбой
второй и следующих частей — прогон «неразмечено» (judge.json с ошибкой и
стоимостью), команда не падает.
";

const COMPARE_USAGE: &str = "\
grill-eval compare <отчёт A> <отчёт B>

Печатает таблицу метрик «A | B | разница» и вопросы, которые появились в B или пропали
из A (пары — одна тема и похожий текст), и пишет то же в compare.md в папке B. Метки
судьи берутся из judge.json, если он есть. Если у прогонов разные отрезок, флаги
(--realtime, --baseline-state, --no-gaps) или правила, сравнение говорит об этом.
";

const BRIEF_USAGE: &str = "\
grill-eval brief <набор>

Собирает бриф набора нынешним промптом брифа приложения (тот же вызов Claude Code) из
описания, заметок, людей и текстов документов набора и записывает его в набор. Прежний
бриф остаётся в поле briefPrevious.
";

/// The arguments after the subcommand.
#[derive(Debug, Default)]
struct Parsed {
    positional: Vec<String>,
    values: HashMap<&'static str, String>,
    switches: HashSet<&'static str>,
}

/// `valued` take a value, `switches` don't; anything else starting with
/// `--` is an error.
fn parse(
    args: &[String],
    valued: &[&'static str],
    switches: &[&'static str],
) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let Some(flag) = arg.strip_prefix("--") else {
            parsed.positional.push(arg.clone());
            continue;
        };
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (flag, None),
        };
        if let Some(known) = valued.iter().find(|known| **known == name) {
            let value = match inline {
                Some(value) => value,
                None => rest
                    .next()
                    .cloned()
                    .ok_or_else(|| format!("У --{name} нет значения"))?,
            };
            parsed.values.insert(known, value);
        } else if let Some(known) = switches.iter().find(|known| **known == name) {
            if inline.is_some() {
                return Err(format!("--{name} без значения"));
            }
            parsed.switches.insert(known);
        } else {
            return Err(format!("Неизвестный флаг --{name}"));
        }
    }
    Ok(parsed)
}

fn wants_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

fn one_positional(parsed: &Parsed, what: &str) -> Result<String, String> {
    match parsed.positional.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(format!("Нужен {what}")),
        _ => Err(format!(
            "Лишние аргументы: {}",
            parsed.positional[1..].join(" ")
        )),
    }
}

/// The entry of `grill-eval`: `args` without the program name.
pub fn main(args: Vec<String>) -> ExitCode {
    let Some((command, rest)) = args.split_first() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = match command.as_str() {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        "export" if wants_help(rest) => {
            print!("{EXPORT_USAGE}");
            return ExitCode::SUCCESS;
        }
        "replay" if wants_help(rest) => {
            print!("{REPLAY_USAGE}");
            return ExitCode::SUCCESS;
        }
        "judge" if wants_help(rest) => {
            print!("{JUDGE_USAGE}");
            return ExitCode::SUCCESS;
        }
        "compare" if wants_help(rest) => {
            print!("{COMPARE_USAGE}");
            return ExitCode::SUCCESS;
        }
        "import" if wants_help(rest) => {
            print!("{IMPORT_USAGE}");
            return ExitCode::SUCCESS;
        }
        "brief" if wants_help(rest) => {
            print!("{BRIEF_USAGE}");
            return ExitCode::SUCCESS;
        }
        "export" => export_command(rest),
        "import" => import_command(rest),
        "replay" => replay_command(rest),
        "judge" => judge_command(rest),
        "compare" => compare_command(rest),
        "brief" => brief_command(rest),
        other => Err(format!(
            "Неизвестная подкоманда «{other}». grill-eval --help — список подкоманд"
        )),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("grill-eval: {message}");
            ExitCode::FAILURE
        }
    }
}

fn eval_dir() -> Result<PathBuf, String> {
    corpus::eval_dir().map_err(|error| format!("Не удалось найти текущую папку: {error}"))
}

fn export_command(args: &[String]) -> Result<ExitCode, String> {
    let parsed = parse(args, &["name", "db"], &["force"])?;
    let recording_id = one_positional(&parsed, "id записи")?;
    let database = match parsed.values.get("db") {
        Some(path) => PathBuf::from(path),
        None => export::default_database()
            .ok_or("Не удалось найти папку данных приложения: укажите --db")?,
    };
    let path = export::run(
        &database,
        &recording_id,
        parsed.values.get("name").map(String::as_str),
        &eval_dir()?,
        parsed.switches.contains("force"),
    )?;
    let corpus = Corpus::load(&path)?;
    println!(
        "Набор {}: {} живых сегментов, {} уточнённых, {:.1} мин → {}",
        corpus.name,
        corpus.live.len(),
        corpus.refined.as_ref().map_or(0, Vec::len),
        minutes(corpus.recording.duration_ms),
        path.display()
    );
    Ok(ExitCode::SUCCESS)
}

#[allow(clippy::cast_precision_loss)]
fn minutes(ms: i64) -> f64 {
    ms as f64 / 60_000.0
}

fn minutes_arg(parsed: &Parsed, name: &str) -> Result<Option<f64>, String> {
    parsed
        .values
        .get(name)
        .map(|value| {
            value
                .parse::<f64>()
                .ok()
                .filter(|minutes| minutes.is_finite() && *minutes >= 0.0)
                .ok_or_else(|| format!("--{name}: нужно число минут, а не «{value}»"))
        })
        .transpose()
}

/// `--quiet-minutes`: whole minutes, at least 1.
fn quiet_minutes_arg(parsed: &Parsed) -> Result<Option<i64>, String> {
    parsed
        .values
        .get("quiet-minutes")
        .map(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|minutes| *minutes >= 1)
                .ok_or_else(|| {
                    format!("--quiet-minutes: нужно целое число минут от 1, а не «{value}»")
                })
        })
        .transpose()
}

/// A folder in `.grill-eval/tmp/`, removed with everything in it when
/// dropped: the prefix files hold the client's project, the import's work
/// files their audio. After a Ctrl-C or a panic it stays there, inside the
/// git-ignored `.grill-eval/`, not in the system's temp dir.
struct Scratch(PathBuf);

impl Scratch {
    fn new(eval_dir: &Path) -> Result<Self, String> {
        let path = eval_dir
            .join(corpus::TMP_DIR)
            .join(format!("grill-eval-{}", storage::new_id()));
        fs::create_dir_all(&path)
            .map_err(|error| format!("Не удалось создать {}: {error}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "grill-eval: не удалось удалить {}: {error}",
                self.0.display()
            );
        }
        // `tmp/` itself goes once it is empty.
        if let Some(parent) = self.0.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

/// A new folder for a report: `<stamp>-<label>-<n>` in `reports`, `n` from
/// 1 up to the first free one. Made atomically, so two runs started in the
/// same second never share it.
fn report_dir(reports: &Path, stamp: &str, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(reports)
        .map_err(|error| format!("Не удалось создать {}: {error}", reports.display()))?;
    for n in 1.. {
        let dir = reports.join(format!("{stamp}-{label}-{n}"));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!("Не удалось создать {}: {error}", dir.display()));
            }
        }
    }
    unreachable!("an unbounded range")
}

/// Claude Code, if it is installed and signed in.
fn ready_cli(cwd: &Path) -> Result<PathBuf, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let cli = discover::find(None, &SearchEnv::from_process())
            .await
            .ok_or("Claude Code не найден")?;
        match agent::status(&cli, cwd, agent::STATUS_TIMEOUT).await {
            AgentState::Ready { .. } => Ok(cli),
            AgentState::NeedsLogin { .. } => {
                Err("Нужен вход в Claude Code: выполните `claude` и войдите".to_owned())
            }
            AgentState::NotInstalled => Err("Claude Code не установлен".to_owned()),
            AgentState::Error { message } => Err(format!("Claude Code: {message}")),
        }
    })
}

fn replay_command(args: &[String]) -> Result<ExitCode, String> {
    let parsed = parse(
        args,
        &["from", "to", "label", "rules", "quiet-minutes"],
        &["realtime", "baseline-state", "no-gaps"],
    )?;
    let argument = one_positional(&parsed, "набор")?;
    let dir = eval_dir()?;
    let corpus_file = corpus::resolve(&dir, &argument);
    let corpus = Corpus::load(&corpus_file)?;
    let corpus_path = fs::canonicalize(&corpus_file)
        .unwrap_or(corpus_file)
        .display()
        .to_string();
    let label = parsed
        .values
        .get("label")
        .cloned()
        .unwrap_or_else(|| "run".to_owned());
    corpus::check_name(&label)?;
    let rules = match parsed.values.get("rules") {
        Some(file) => Some(replay::Rules {
            file: file.clone(),
            text: fs::read_to_string(file)
                .map_err(|error| format!("Не удалось прочитать правила {file}: {error}"))?,
        }),
        None => None,
    };
    let options = replay::Options {
        from_min: minutes_arg(&parsed, "from")?,
        to_min: minutes_arg(&parsed, "to")?,
        label: label.clone(),
        rules,
        realtime: parsed.switches.contains("realtime"),
        baseline_state: parsed.switches.contains("baseline-state"),
        no_gaps: parsed.switches.contains("no-gaps"),
        quiet_minutes: quiet_minutes_arg(&parsed)?,
        corpus_path: Some(corpus_path),
        progress: true,
    };
    if let (Some(from), Some(to)) = (options.from_min, options.to_min)
        && from >= to
    {
        return Err("--from должен быть меньше --to".to_owned());
    }

    let scratch = Scratch::new(&dir)?;
    let cli = ready_cli(&scratch.0)?;
    let agent: Arc<dyn Agent> = Arc::new(ClaudeCodeCli::new(cli, &scratch.0));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(!options.realtime)
        .build()
        .map_err(|error| error.to_string())?;
    let report = runtime.block_on(replay::run(
        &corpus,
        agent,
        &options,
        &scratch.0.join("prompts"),
        replay::FOLLOW,
    ))?;
    drop(runtime);

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let path = report_dir(&dir.join("reports"), &stamp, &label)?.join(report::REPORT_FILE);
    corpus::write_json(&path, &report)?;
    write_markdown(&path, &report, None)?;
    let cost: f64 = report.calls.iter().filter_map(|call| call.cost_usd).sum();
    println!(
        "{}: {} вызовов, {} показанных вопросов (не показано {}), {} тем, ${cost:.2}, \
         {:.1} мин → {}",
        if report.complete {
            "Прогон завершён"
        } else {
            "Прогон неполный"
        },
        report.calls.len(),
        report.shown().count(),
        report.never_shown().count(),
        report.topics.len(),
        minutes(report.run.wall_ms),
        path.display()
    );
    match &report.stopped {
        Some(reason) => {
            eprintln!("grill-eval: прогон остановлен: {reason}");
            Ok(ExitCode::FAILURE)
        }
        None => Ok(ExitCode::SUCCESS),
    }
}

/// `report.md` next to the report file `path`.
fn write_markdown(
    path: &Path,
    report: &Report,
    judge: Option<&judge::Judge>,
) -> Result<(), String> {
    let file = path.with_file_name(report::MARKDOWN_FILE);
    fs::write(&file, metrics::markdown(report, judge))
        .map_err(|error| format!("Не удалось записать {}: {error}", file.display()))
}

/// `judge.json` next to the report file `path`, if the judge ran.
fn load_judge(path: &Path) -> Result<Option<judge::Judge>, String> {
    let file = path.with_file_name(judge::JUDGE_FILE);
    if !file.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", file.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("{} не по формату: {error}", file.display()))
}

/// A runtime for the agent call of a subcommand.
fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
}

fn judge_command(args: &[String]) -> Result<ExitCode, String> {
    let parsed = parse(args, &[], &[])?;
    let path = report::file_of(Path::new(&one_positional(&parsed, "отчёт")?));
    let report = Report::load(&path)?;
    let dir = eval_dir()?;
    // The file the run read; by name for a report without it, or when it
    // moved.
    let corpus_file = report
        .corpus_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|file| file.is_file())
        .unwrap_or_else(|| corpus::resolve(&dir, &report.corpus));
    let corpus = Corpus::load(&corpus_file)?;

    let scratch = Scratch::new(&dir)?;
    let cli = ready_cli(&scratch.0)?;
    let agent: Arc<dyn Agent> = Arc::new(ClaudeCodeCli::new(cli, &scratch.0));
    let judged = runtime()?.block_on(judge::run(&corpus, &report, agent, &scratch.0))?;
    let file = path.with_file_name(judge::JUDGE_FILE);
    corpus::write_json(&file, &judged)?;
    write_markdown(&path, &report, Some(&judged))?;

    let cost = judged.cost_usd.unwrap_or(0.0);
    if !judged.labeled {
        eprintln!(
            "grill-eval: прогон неразмечен: {}",
            judged.error.as_deref().unwrap_or("ответ не по схеме")
        );
        println!("Судья: неразмечено, ${cost:.2} → {}", file.display());
        return Ok(ExitCode::SUCCESS);
    }
    let found = metrics::compute(&report, Some(&judged));
    let labels = found.labels.unwrap_or_default();
    let counts: Vec<String> = judge::Label::ALL
        .into_iter()
        .map(|label| format!("{} {}", label.title(), labels.count(label)))
        .collect();
    let coverage = found.coverage.map_or_else(String::new, |coverage| {
        format!(", покрытие {} из {}", coverage.covered, coverage.total)
    });
    println!(
        "Судья: размечено {} из {} показанных ({}){coverage}, отброшено {}, ${cost:.2} → {}",
        labels.labeled,
        found.questions,
        counts.join(", "),
        judged.dropped.len(),
        file.display()
    );
    Ok(ExitCode::SUCCESS)
}

fn compare_command(args: &[String]) -> Result<ExitCode, String> {
    let parsed = parse(args, &[], &[])?;
    let [a, b] = parsed.positional.as_slice() else {
        return Err("Нужны два отчёта: grill-eval compare <отчёт A> <отчёт B>".to_owned());
    };
    let (path_a, path_b) = (report::file_of(Path::new(a)), report::file_of(Path::new(b)));
    let (report_a, report_b) = (Report::load(&path_a)?, Report::load(&path_b)?);
    let (judge_a, judge_b) = (load_judge(&path_a)?, load_judge(&path_b)?);
    let text = compare::markdown(
        &compare::Run {
            report: &report_a,
            judge: judge_a.as_ref(),
            place: path_a.display().to_string(),
        },
        &compare::Run {
            report: &report_b,
            judge: judge_b.as_ref(),
            place: path_b.display().to_string(),
        },
    );
    print!("{text}");
    let file = path_b.with_file_name(compare::COMPARE_FILE);
    fs::write(&file, &text)
        .map_err(|error| format!("Не удалось записать {}: {error}", file.display()))?;
    eprintln!("→ {}", file.display());
    Ok(ExitCode::SUCCESS)
}

fn brief_command(args: &[String]) -> Result<ExitCode, String> {
    let parsed = parse(args, &[], &[])?;
    let dir = eval_dir()?;
    let path = corpus::resolve(&dir, &one_positional(&parsed, "набор")?);
    let mut corpus = Corpus::load(&path)?;
    // Nothing to build from: an error before the agent is looked for.
    brief::inputs(&corpus)?;

    let scratch = Scratch::new(&dir)?;
    let cli = ready_cli(&scratch.0)?;
    let agent: Arc<dyn Agent> = Arc::new(ClaudeCodeCli::new(cli, &scratch.0));
    let usage = runtime()?.block_on(brief::run(&mut corpus, agent, &scratch.0))?;
    corpus.save(&path)?;

    let gaps = corpus
        .project
        .as_ref()
        .and_then(|project| project.brief.as_ref())
        .map(assembly::brief_gaps)
        .unwrap_or_default();
    println!(
        "Бриф набора {} пересобран за {:.0} с, ${:.2}; «Неясно до звонка»: {} → {}",
        corpus.name,
        Duration::from_millis(usage.duration_ms).as_secs_f64(),
        usage.cost_usd.unwrap_or(0.0),
        gaps.len(),
        path.display()
    );
    for (index, (lens, text)) in gaps.iter().enumerate() {
        println!("G{} ({}): {text}", index + 1, lens.label());
    }
    Ok(ExitCode::SUCCESS)
}

/// `--docs` takes every file up to the next flag; the rest of `args` goes
/// to [`parse`].
fn split_docs(args: &[String]) -> (Vec<String>, Vec<PathBuf>) {
    let mut rest = Vec::new();
    let mut docs = Vec::new();
    let mut in_docs = false;
    for arg in args {
        if arg == "--docs" {
            in_docs = true;
        } else if let Some(file) = arg.strip_prefix("--docs=") {
            docs.push(PathBuf::from(file));
            in_docs = true;
        } else if arg.starts_with("--") {
            in_docs = false;
            rest.push(arg.clone());
        } else if in_docs {
            docs.push(PathBuf::from(arg));
        } else {
            rest.push(arg.clone());
        }
    }
    (rest, docs)
}

fn import_command(args: &[String]) -> Result<ExitCode, String> {
    let (args, docs) = split_docs(args);
    let parsed = parse(
        &args,
        &["others", "channels", "project", "people", "manager", "name"],
        &["force"],
    )?;
    let path = |name: &str| parsed.values.get(name).map(PathBuf::from);
    let mut options = import::Options {
        audio: PathBuf::from(one_positional(&parsed, "аудиофайл")?),
        others: path("others"),
        channels: parsed
            .values
            .get("channels")
            .map(|value| import::parse_layout(value))
            .transpose()?,
        project: path("project").ok_or("Нужен --project <описание.md>")?,
        docs,
        people: path("people"),
        manager: parsed.values.get("manager").cloned(),
        name: parsed.values.get("name").cloned(),
        settings: storage::settings::SettingsMap::new(),
        force: parsed.switches.contains("force"),
        progress: true,
    };
    // A taken name fails before the long work, not after it.
    let dir = eval_dir()?;
    let name = import::name_of(&options);
    corpus::check_name(&name)?;
    corpus::check_free(&dir, &name, options.force)?;
    let given = [&options.audio, &options.project]
        .into_iter()
        .chain(&options.others)
        .chain(&options.people)
        .chain(&options.docs);
    for file in given {
        if !file.is_file() {
            return Err(format!("Нет файла {}", file.display()));
        }
    }
    let data = export::app_data_dir().ok_or("Не удалось найти папку данных приложения")?;
    let (settings, selected) = import::app_settings(&data.join(storage::DATABASE_FILE))?;
    options.settings = settings;
    let (model, model_path) = import::installed_model(&data.join("models"), selected)?;
    let layout = import::layout(&options, &Ffmpeg)?;
    let scratch = Scratch::new(&dir)?;
    let agent = match layout {
        Layout::Mono => {
            Some(Arc::new(ClaudeCodeCli::new(ready_cli(&scratch.0)?, &scratch.0)) as Arc<dyn Agent>)
        }
        _ => None,
    };
    eprintln!("grill-eval: декодирую ({layout:?}) через ffmpeg…");
    let tracks = import::decode(&options, layout, &Ffmpeg)?;
    let speech = Speech {
        recognizer: Recognizer::whisper(Some(model_path)),
        model,
        vad_model: vad::dev_model_path(),
    };
    let imported = tauri::async_runtime::block_on(import::run(
        &options, layout, &tracks, &speech, agent, &dir, &scratch.0,
    ))?;

    let corpus = &imported.corpus;
    let count = |channel| {
        corpus
            .live
            .iter()
            .filter(|segment| segment.channel == channel)
            .count()
    };
    println!(
        "Набор {}: {} живых сегментов (Я {}, Остальные {}), {} уточнённых, {:.1} мин, \
         каналы {}, модель {} → {}",
        corpus.name,
        corpus.live.len(),
        count(TranscriptChannel::Me),
        count(TranscriptChannel::Others),
        corpus.refined.as_ref().map_or(0, Vec::len),
        minutes(corpus.recording.duration_ms),
        match corpus.channels {
            corpus::Channels::Real => "настоящие",
            corpus::Channels::Approximate => "приблизительные (моно)",
        },
        model.as_str(),
        imported.path.display()
    );
    if let Some(usage) = &imported.labeling {
        println!(
            "Разметка моно: {:.1} с, ${}",
            Duration::from_millis(usage.duration_ms).as_secs_f64(),
            usage
                .cost_usd
                .map_or_else(|| "?".to_owned(), |cost| format!("{cost:.4}"))
        );
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn flags_take_values_both_ways() {
        let parsed = parse(
            &args(&["obmen", "--from", "40", "--to=75", "--realtime"]),
            &["from", "to"],
            &["realtime"],
        )
        .unwrap();
        assert_eq!(parsed.positional, ["obmen"]);
        assert_eq!(parsed.values["from"], "40");
        assert_eq!(parsed.values["to"], "75");
        assert!(parsed.switches.contains("realtime"));
    }

    #[test]
    fn unknown_and_empty_flags_are_errors() {
        assert!(parse(&args(&["--nope"]), &["from"], &[]).is_err());
        assert!(parse(&args(&["--from"]), &["from"], &[]).is_err());
        assert!(parse(&args(&["--realtime=yes"]), &[], &["realtime"]).is_err());
        let parsed = parse(&args(&["x", "--from", "abc"]), &["from"], &[]).unwrap();
        assert!(minutes_arg(&parsed, "from").is_err());
    }

    #[test]
    fn docs_take_the_files_up_to_the_next_flag() {
        let (rest, docs) = split_docs(&args(&[
            "call.m4a",
            "--docs",
            "tz.pdf",
            "notes.md",
            "--project",
            "p.md",
            "--docs=brief.docx",
        ]));
        assert_eq!(rest, ["call.m4a", "--project", "p.md"]);
        assert_eq!(
            docs,
            ["tz.pdf", "notes.md", "brief.docx"].map(PathBuf::from)
        );
        assert_eq!(main(args(&["import", "--help"])), ExitCode::SUCCESS);
        assert_eq!(main(args(&["import", "a.wav"])), ExitCode::FAILURE);
    }

    /// Two runs with one label in the same second get their own folders.
    #[test]
    fn report_folders_never_collide() {
        let dir = tempfile::tempdir().unwrap();
        let reports = dir.path().join("reports");
        let first = report_dir(&reports, "20261109-120000", "run").unwrap();
        let second = report_dir(&reports, "20261109-120000", "run").unwrap();
        assert_eq!(first, reports.join("20261109-120000-run-1"));
        assert_eq!(second, reports.join("20261109-120000-run-2"));
        assert!(first.is_dir() && second.is_dir());
    }

    /// The scratch folder is in `.grill-eval/tmp/`, gone with `tmp/` when
    /// dropped.
    #[test]
    fn the_scratch_folder_is_in_the_eval_dir() {
        let dir = tempfile::tempdir().unwrap();
        let scratch = Scratch::new(dir.path()).unwrap();
        assert!(scratch.0.starts_with(dir.path().join("tmp")));
        assert!(scratch.0.is_dir());
        drop(scratch);
        assert!(!dir.path().join("tmp").exists());
    }

    #[test]
    fn wrong_arguments_and_help() {
        assert_eq!(main(args(&["compare", "only-one"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["what"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["--help"])), ExitCode::SUCCESS);
        assert_eq!(main(args(&["replay", "--help"])), ExitCode::SUCCESS);
        for command in ["import", "judge", "compare", "brief"] {
            assert_eq!(main(args(&[command, "--help"])), ExitCode::SUCCESS);
        }
    }
}
