//! The agent never reaches a connector (connectors-outline task 3.5;
//! `connectors`, «Вызов агента при подключённом Outline»): with Outline
//! connected, the brief's and the fast loop's calls of `ClaudeCodeCli` run
//! with no MCP and no tools, and neither their arguments nor their
//! environment has the key. The documents' text comes on stdin, as the
//! project's materials. Against a fake `claude` script.

use std::{fs, os::unix::fs::PermissionsExt as _, path::Path};

use tokio::sync::oneshot;

use super::{
    ConnectorKind, SelectionItem, SelectionItemKind,
    clickup::fake::{FakeClickUp, TOKEN},
    testing::{FakeOutline, Host, KEY, block_on, collection},
};
use crate::{
    agent::{
        claude_cli::{Agent as _, AgentRequest, CallOptions, ClaudeCodeCli},
        fast_loop::patch,
        process::TreeSlot,
    },
    projects::{
        brief::{
            input::compose,
            run::{PromptFile, request},
        },
        brief_inputs,
    },
};

/// Writes its arguments (NUL-separated), its whole environment and stdin,
/// then exits without a reply.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
env > "$STATE/env"
cat > "$STATE/stdin"
exit 1
"#;

fn fake_cli(dir: &Path) -> ClaudeCodeCli {
    let cli = dir.join("bin/claude");
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(
        &cli,
        FAKE_CLAUDE.replace("@STATE@", &dir.display().to_string()),
    )
    .unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    ClaudeCodeCli::new(cli, dir.join("agent"))
}

/// Runs `request` and returns what the CLI got: its arguments, environment
/// and stdin.
fn run(cli: &ClaudeCodeCli, dir: &Path, request: AgentRequest) -> (Vec<String>, String, String) {
    let (_cancel, cancelled) = oneshot::channel();
    let _ = block_on(cli.run(request, cancelled));
    let args = fs::read_to_string(dir.join("args")).unwrap();
    let args = args
        .strip_suffix('\0')
        .unwrap_or(&args)
        .split('\0')
        .map(str::to_owned)
        .collect();
    (
        args,
        fs::read_to_string(dir.join("env")).unwrap(),
        fs::read_to_string(dir.join("stdin")).unwrap(),
    )
}

fn assert_isolated(args: &[String], env: &str, origin: &str) {
    let tools = args.iter().position(|arg| arg == "--tools").unwrap();
    assert_eq!(args[tools + 1], "", "no tools");
    assert!(
        args.iter().any(|arg| arg == "--strict-mcp-config"),
        "no MCP"
    );
    assert!(!args.iter().any(|arg| arg == "--mcp-config"));
    for text in [KEY, "ol_api_", origin] {
        assert!(
            !args.iter().any(|arg| arg.contains(text)),
            "{text} in the arguments"
        );
        assert!(!env.contains(text), "{text} in the environment");
    }
}

#[test]
fn the_agent_gets_the_documents_but_never_the_key_or_a_tool() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 1);
    fake.state().edit("tm-1", "Перезвон клиенту за 5 минут");
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    assert!(
        host.secrets.raw().values().any(|value| value.contains(KEY)),
        "Outline is connected"
    );

    let dir = tempfile::tempdir().unwrap();
    let cli = fake_cli(dir.path());

    // The brief's call.
    let id = project.clone();
    let inputs = block_on(host.storage.read(move |db| brief_inputs::read(db, &id))).unwrap();
    let message = compose(&inputs).unwrap();
    let prompt = PromptFile::write(&dir.path().join("briefs"), &project).unwrap();
    let (args, env, stdin) = run(
        &cli,
        dir.path(),
        request(&prompt, &message, TreeSlot::default(), None),
    );
    assert_isolated(&args, &env, &fake.origin);
    assert!(
        stdin.contains("Перезвон клиенту за 5 минут"),
        "the text comes as material"
    );
    assert!(stdin.contains("Outline: Документ tm-1"));
    assert!(!stdin.contains(KEY));

    // The fast loop's call: the same minimal mode.
    let file = dir.path().join("fast-loop.md");
    fs::write(&file, "# Правила").unwrap();
    let fast = AgentRequest {
        system_prompt_file: file,
        user_message: "Режим: обычный".to_owned(),
        schema: patch::schema_argument().to_owned(),
        process: TreeSlot::default(),
        options: CallOptions::default(),
    };
    let (args, env, _) = run(&cli, dir.path(), fast);
    assert_isolated(&args, &env, &fake.origin);
}

/// `clickup-connector` (task 2.5): with ClickUp connected, the brief's call
/// gets the tasks' text, never the token or ClickUp's address.
#[test]
fn the_agent_gets_the_tasks_but_never_the_clickup_token() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 1);
        state.edit("l1-1", "Интеграция с МИС до марта");
    }
    let host = Host::clickup(&fake);
    host.connect_clickup(TOKEN, None);
    let project = host.project("Телемедиа");
    host.select_in(
        ConnectorKind::ClickUp,
        &project,
        vec![SelectionItem {
            item_kind: SelectionItemKind::Container,
            external_id: "list:l1".to_owned(),
            title: "Список l1".to_owned(),
            url: None,
        }],
    )
    .unwrap();
    assert!(
        host.secrets
            .raw()
            .values()
            .any(|value| value.contains(TOKEN)),
        "ClickUp is connected"
    );

    let dir = tempfile::tempdir().unwrap();
    let cli = fake_cli(dir.path());
    let id = project.clone();
    let inputs = block_on(host.storage.read(move |db| brief_inputs::read(db, &id))).unwrap();
    let message = compose(&inputs).unwrap();
    let prompt = PromptFile::write(&dir.path().join("briefs"), &project).unwrap();
    let (args, env, stdin) = run(
        &cli,
        dir.path(),
        request(&prompt, &message, TreeSlot::default(), None),
    );
    let tools = args.iter().position(|arg| arg == "--tools").unwrap();
    assert_eq!(args[tools + 1], "", "no tools");
    for text in [TOKEN, "pk_", fake.base.as_str()] {
        assert!(
            !args.iter().any(|arg| arg.contains(text)),
            "{text} in the arguments"
        );
        assert!(!env.contains(text), "{text} in the environment");
        assert!(!stdin.contains(text), "{text} on stdin");
    }
    assert!(
        stdin.contains("Интеграция с МИС до марта"),
        "the task comes as material"
    );
}
