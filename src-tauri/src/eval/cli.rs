//! The subcommands of `grill-eval` and their arguments (question-quality
//! design.md, decision 1). The arguments are few, so they are read here by
//! hand: `--flag value`, `--flag=value` and switches.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::ExitCode,
};

use super::{
    corpus::{self, Corpus},
    export,
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
      Прогон набора через быстрый контур. Пока не реализовано.
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
        "export" => export_command(rest),
        "import" | "brief" | "replay" | "judge" | "compare" => {
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
    }

    #[test]
    fn subcommands_not_built_yet_fail() {
        assert_eq!(main(args(&["judge", "report.json"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["what"])), ExitCode::FAILURE);
        assert_eq!(main(args(&["--help"])), ExitCode::SUCCESS);
        assert_eq!(main(args(&["export", "--help"])), ExitCode::SUCCESS);
    }
}
