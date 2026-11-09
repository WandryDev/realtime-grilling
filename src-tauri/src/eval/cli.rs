//! The subcommands of `grill-eval` and their arguments (question-quality
//! design.md, decision 1). The arguments are few, so they are read here by
//! hand: `--flag value`, `--flag=value` and switches.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
};

use super::{
    corpus::{self, Corpus},
    export, replay,
};
use crate::{
    agent::{
        self, AgentState,
        claude_cli::{Agent, ClaudeCodeCli},
        discover::{self, SearchEnv},
    },
    storage,
};

const USAGE: &str = "\
grill-eval — прогон записанных звонков через быстрый контур.

Использование: grill-eval <подкоманда> [аргументы]

Подкоманды:
  export <id записи> [--name N] [--db ФАЙЛ]
      Запись из базы приложения (только чтение) в набор .grill-eval/corpus/<N>.json.
  import <аудио> [--others <аудио>] [--channels left=me|right=me|mono]
         --project <описание.md> [--docs <файлы>] [--people <people.json>] [--name N]
      Внешняя запись звонка в набор. Пока не реализовано.
  brief <набор>
      Пересобрать бриф набора нынешним промптом брифа. Пока не реализовано.
  replay <набор> [--from M] [--to M] [--label L] [--rules ФАЙЛ] [--realtime]
      Прогон набора через быстрый контур с настоящим Claude Code. Отчёт —
      .grill-eval/reports/<время>-<L>/report.json.
  judge <отчёт>
      Разметка вопросов прогона LLM-судьёй. Пока не реализовано.
  compare <отчёт A> <отчёт B>
      Сравнение двух прогонов одного набора. Пока не реализовано.

Каталог .grill-eval/ — в корне репозитория (ближайшая папка вверх от текущей, где
есть .git), он в .gitignore. `grill-eval <подкоманда> --help` — справка по подкоманде.
";

const EXPORT_USAGE: &str = "\
grill-eval export <id записи> [--name N] [--db ФАЙЛ]

Выгружает запись из базы приложения в набор .grill-eval/corpus/<N>.json: живую и
уточнённую расшифровку, проект с брифом и текстами документов, людей, глоссарий,
настройки быстрого контура, исходные темы, вопросы и вызовы агента.

  --name N    имя набора (по умолчанию id записи)
  --db ФАЙЛ   база приложения (по умолчанию база приложения этого пользователя)

База открывается только на чтение. Запись без живой расшифровки — ошибка, файл не создаётся.
";

const REPLAY_USAGE: &str = "\
grill-eval replay <набор> [--from M] [--to M] [--label L] [--rules ФАЙЛ] [--realtime]

Прогоняет набор (имя в .grill-eval/corpus/ или путь к файлу) через быстрый контур
приложения с настоящим Claude Code. Простой между фразами пропускается, во время
вызова часы идут вместе с реальным временем. База приложения не открывается.

  --from M, --to M  только фразы, начавшиеся с M-й по M-ю минуту
  --label L         метка отчёта (по умолчанию run)
  --rules ФАЙЛ      правила промпта из файла вместо встроенных
  --realtime        на настоящих часах, без пропуска простоя

Отчёт: .grill-eval/reports/<время>-<L>/report.json. Если агент недоступен (нет входа,
исчерпан лимит), прогон останавливается и отчёт сохраняется как неполный.
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
        "export" => export_command(rest),
        "replay" => replay_command(rest),
        "import" | "brief" | "judge" | "compare" => {
            if wants_help(rest) {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            Err(format!("grill-eval {command}: ещё не реализовано"))
        }
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
    let parsed = parse(args, &["name", "db"], &[])?;
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

/// A folder in the system's temp dir, removed with everything in it when
/// dropped: the prefix files hold the client's project.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("grill-eval-{}", storage::new_id()));
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
    }
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
    let parsed = parse(args, &["from", "to", "label", "rules"], &["realtime"])?;
    let argument = one_positional(&parsed, "набор")?;
    let dir = eval_dir()?;
    let corpus = Corpus::load(&corpus::resolve(&dir, &argument))?;
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
        progress: true,
    };
    if let (Some(from), Some(to)) = (options.from_min, options.to_min)
        && from >= to
    {
        return Err("--from должен быть меньше --to".to_owned());
    }

    let scratch = Scratch::new()?;
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

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir
        .join("reports")
        .join(format!("{stamp}-{label}"))
        .join("report.json");
    corpus::write_json(&path, &report)?;
    let cost: f64 = report.calls.iter().filter_map(|call| call.cost_usd).sum();
    println!(
        "{}: {} вызовов, {} вопросов, {} тем, ${cost:.2}, {:.1} мин → {}",
        if report.complete {
            "Прогон завершён"
        } else {
            "Прогон неполный"
        },
        report.calls.len(),
        report.questions.len(),
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
    fn subcommands_not_built_yet_fail() {
        assert_eq!(main(args(&["judge", "report.json"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["what"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["--help"])), ExitCode::SUCCESS);
        assert_eq!(main(args(&["replay", "--help"])), ExitCode::SUCCESS);
    }
}
