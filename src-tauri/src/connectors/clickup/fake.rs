//! A fake ClickUp API v2 on 127.0.0.1 (HTTP/1.1, one request per
//! connection), like the fake Outline of `connectors::testing`: workspaces,
//! spaces, folders, lists, tasks with subtasks and comments, the rate
//! headers and 429s. It binds with the standard library and serves on
//! Tauri's runtime, so it starts in a `#[tokio::test]` too.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
};

use super::client::{COMMENT_PAGE, PAGE};

pub const TOKEN: &str = "pk_81234567_Q9WZK3HLM2XPRT7VYB4NC6DJ8FGA5SEU";
pub const TEAM: &str = "9012345";
pub const OTHER_TEAM: &str = "9054321";

#[derive(Debug, Clone)]
pub struct FakeComment {
    pub id: String,
    pub author: String,
    pub text: String,
    /// Milliseconds since the Unix epoch.
    pub date: u64,
}

#[derive(Debug, Clone)]
pub struct FakeTask {
    pub id: String,
    pub name: String,
    pub description: String,
    pub list: String,
    pub parent: Option<String>,
    pub status: String,
    pub closed: bool,
    pub archived: bool,
    pub updated: u64,
    pub assignees: Vec<String>,
    pub comments: Vec<FakeComment>,
}

#[derive(Debug, Clone)]
pub struct Container {
    pub id: String,
    pub name: String,
    /// The space of a folder or a list; the team of a space.
    pub parent: String,
    /// The folder of a list.
    pub folder: Option<String>,
    pub archived: bool,
}

/// What the rate headers say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rate {
    /// A big window (10 000 a minute, as on Enterprise) counting down with
    /// each request, the reset a minute ahead.
    Plenty,
    /// `Remaining: 0`, the reset this many seconds ahead.
    Exhausted(u64),
    /// No rate headers.
    None,
}

/// A request the fake got.
#[derive(Debug, Clone)]
pub struct Logged {
    pub path: String,
    pub query: Vec<(String, String)>,
    pub authorization: Option<String>,
}

impl Logged {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug)]
pub struct State {
    pub token: String,
    pub user: String,
    pub teams: Vec<(String, String)>,
    pub spaces: Vec<Container>,
    pub folders: Vec<Container>,
    pub lists: Vec<Container>,
    pub tasks: Vec<FakeTask>,
    pub rate: Rate,
    /// The next requests answered 429; with the reset this many seconds
    /// ahead, or without the header.
    pub throttled: u32,
    pub throttle_reset: Option<u64>,
    /// Answers 503.
    pub down: bool,
    /// The subtasks in a task's answer come without their description.
    pub bare_subtasks: bool,
    /// Teams the token no longer opens: their resources answer 401
    /// (`OAUTH_027`).
    pub foreign_teams: Vec<String>,
    pub log: Vec<Logged>,
    clock: u64,
}

impl State {
    /// A version later than every one before.
    pub fn tick(&mut self) -> u64 {
        self.clock += 1_000;
        self.clock
    }

    pub fn add_space(&mut self, id: &str, name: &str) {
        self.add_space_in(TEAM, id, name);
    }

    pub fn add_space_in(&mut self, team: &str, id: &str, name: &str) {
        self.spaces.push(Container {
            id: id.to_owned(),
            name: name.to_owned(),
            parent: team.to_owned(),
            folder: None,
            archived: false,
        });
    }

    pub fn add_folder(&mut self, space: &str, id: &str, name: &str) {
        self.folders.push(Container {
            id: id.to_owned(),
            name: name.to_owned(),
            parent: space.to_owned(),
            folder: None,
            archived: false,
        });
    }

    /// A list of the space (in `folder`, if any) with `count` open tasks
    /// `<id>-1…`.
    pub fn add_list(&mut self, space: &str, folder: Option<&str>, id: &str, count: usize) {
        self.lists.push(Container {
            id: id.to_owned(),
            name: format!("Список {id}"),
            parent: space.to_owned(),
            folder: folder.map(str::to_owned),
            archived: false,
        });
        for index in 1..=count {
            self.add_task(id, &format!("{id}-{index}"), None);
        }
    }

    pub fn add_task(&mut self, list: &str, id: &str, parent: Option<&str>) {
        let updated = self.tick();
        self.tasks.push(FakeTask {
            id: id.to_owned(),
            name: format!("Задача {id}"),
            description: format!("Описание задачи {id}."),
            list: list.to_owned(),
            parent: parent.map(str::to_owned),
            status: "to do".to_owned(),
            closed: false,
            archived: false,
            updated,
            assignees: vec!["Аня".to_owned()],
            comments: Vec::new(),
        });
    }

    pub fn task_mut(&mut self, id: &str) -> &mut FakeTask {
        self.tasks
            .iter_mut()
            .find(|task| task.id == id)
            .expect("a task of the fake")
    }

    pub fn edit(&mut self, id: &str, description: &str) {
        let updated = self.tick();
        let task = self.task_mut(id);
        task.description = description.to_owned();
        task.updated = updated;
    }

    pub fn close(&mut self, id: &str) {
        let updated = self.tick();
        let task = self.task_mut(id);
        task.closed = true;
        task.status = "complete".to_owned();
        task.updated = updated;
    }

    pub fn archive(&mut self, id: &str) {
        let updated = self.tick();
        let task = self.task_mut(id);
        task.archived = true;
        task.updated = updated;
    }

    pub fn comment(&mut self, task: &str, author: &str, text: &str) {
        let date = self.tick();
        let task = self.task_mut(task);
        let id = format!("{}-c{}", task.id, task.comments.len() + 1);
        task.comments.push(FakeComment {
            id,
            author: author.to_owned(),
            text: text.to_owned(),
            date,
        });
    }

    pub fn delete_list(&mut self, id: &str) {
        self.lists.retain(|list| list.id != id);
        self.tasks.retain(|task| task.list != id);
    }

    pub fn requests(&self, prefix: &str) -> usize {
        self.log
            .iter()
            .filter(|logged| logged.path.starts_with(prefix))
            .count()
    }

    fn list(&self, id: &str) -> Option<&Container> {
        self.lists.iter().find(|list| list.id == id)
    }

    fn space(&self, id: &str) -> Option<&Container> {
        self.spaces.iter().find(|space| space.id == id)
    }

    fn folder(&self, id: &str) -> Option<&Container> {
        self.folders.iter().find(|folder| folder.id == id)
    }

    /// The team of a space, folder or list.
    fn team_of_space(&self, space: &str) -> Option<&str> {
        self.space(space).map(|space| space.parent.as_str())
    }

    fn task_json(&self, task: &FakeTask, subtasks: bool) -> Value {
        let list = self.list(&task.list);
        let space = list.map(|list| list.parent.clone());
        let folder = list
            .and_then(|list| list.folder.as_ref())
            .and_then(|folder| self.folder(folder));
        let mut value = json!({
            "id": task.id,
            "name": task.name,
            "text_content": task.description,
            "description": task.description,
            "markdown_description": task.description,
            "status": {
                "status": task.status,
                "type": if task.closed { "closed" } else { "open" },
            },
            "date_updated": task.updated.to_string(),
            "url": format!("https://app.clickup.com/t/{}", task.id),
            "list": { "id": task.list, "name": list.map(|list| list.name.clone()) },
            "folder": match folder {
                Some(folder) => json!({ "id": folder.id, "name": folder.name, "hidden": false }),
                None => json!({ "id": format!("hidden-{}", task.list), "name": "hidden", "hidden": true }),
            },
            "space": { "id": space },
            "parent": task.parent,
            "archived": task.archived,
            "assignees": task.assignees.iter().map(|name| json!({ "username": name })).collect::<Vec<_>>(),
        });
        if subtasks {
            value["subtasks"] = self
                .tasks
                .iter()
                .filter(|sub| sub.parent.as_deref() == Some(task.id.as_str()))
                .map(|sub| {
                    let mut value = self.task_json(sub, false);
                    if self.bare_subtasks
                        && let Some(fields) = value.as_object_mut()
                    {
                        for field in ["text_content", "description", "markdown_description"] {
                            fields.remove(field);
                        }
                    }
                    value
                })
                .collect();
        }
        value
    }
}

pub struct FakeClickUp {
    /// The API's base, `http://127.0.0.1:<port>/api/v2`.
    pub base: String,
    state: Arc<Mutex<State>>,
}

impl FakeClickUp {
    pub fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/api/v2", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            token: TOKEN.to_owned(),
            user: "Дима Капиш".to_owned(),
            teams: vec![(TEAM.to_owned(), "Pixel Agency".to_owned())],
            spaces: Vec::new(),
            folders: Vec::new(),
            lists: Vec::new(),
            tasks: Vec::new(),
            rate: Rate::Plenty,
            throttled: 0,
            throttle_reset: None,
            down: false,
            bare_subtasks: false,
            foreign_teams: Vec::new(),
            log: Vec::new(),
            clock: 1_767_225_600_000,
        }));
        let shared = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            let listener = TcpListener::from_std(listener).unwrap();
            while let Ok((socket, _)) = listener.accept().await {
                tauri::async_runtime::spawn(respond(socket, Arc::clone(&shared)));
            }
        });
        Self { base, state }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

async fn respond(mut socket: TcpStream, state: Arc<Mutex<State>>) {
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let head_end = loop {
        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
    };
    let head = String::from_utf8_lossy(&request[..head_end]).into_owned();
    let authorization = head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_owned())
    });
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_owned();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let path = path.strip_prefix("/api/v2").unwrap_or(path).to_owned();
    let query: Vec<(String, String)> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(key), decode(value))
        })
        .collect();

    let (status, headers, body) = {
        let mut state = state.lock().unwrap();
        state.log.push(Logged {
            path: path.clone(),
            query: query.clone(),
            authorization: authorization.clone(),
        });
        route(&mut state, &path, &query, authorization.as_deref())
    };
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn rate_headers(remaining: u64, reset_in: u64) -> String {
    format!(
        "X-RateLimit-Limit: 100\r\nX-RateLimit-Remaining: {remaining}\r\nX-RateLimit-Reset: {}\r\n",
        now_secs() + reset_in
    )
}

fn error(status: u16, message: &str, code: &str) -> (u16, Value) {
    (status, json!({ "err": message, "ECODE": code }))
}

fn route(
    state: &mut State,
    path: &str,
    query: &[(String, String)],
    authorization: Option<&str>,
) -> (u16, String, String) {
    if state.down {
        return (503, String::new(), "{}".to_owned());
    }
    if state.throttled > 0 {
        state.throttled -= 1;
        let headers = match state.throttle_reset {
            Some(reset_in) => rate_headers(0, reset_in),
            None => String::new(),
        };
        return (
            429,
            headers,
            json!({ "err": "Rate limit reached", "ECODE": "APP_002" }).to_string(),
        );
    }
    let headers = match state.rate {
        Rate::Plenty => rate_headers(10_000u64.saturating_sub(state.log.len() as u64), 60),
        Rate::Exhausted(reset_in) => rate_headers(0, reset_in),
        Rate::None => String::new(),
    };
    let (status, body) = if authorization != Some(state.token.as_str()) {
        error(401, "Token invalid", "OAUTH_025")
    } else {
        answer(state, path, query)
    };
    (status, headers, body.to_string())
}

fn params<'a>(query: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    query
        .iter()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .collect()
}

fn list_json(state: &State, list: &Container) -> Value {
    let count = state
        .tasks
        .iter()
        .filter(|task| task.list == list.id && !task.archived)
        .count();
    // ClickUp gives it as a number or a string.
    json!({ "id": list.id, "name": list.name, "task_count": count.to_string(), "archived": list.archived })
}

fn answer(state: &State, path: &str, query: &[(String, String)]) -> (u16, Value) {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let foreign =
        |team: Option<&str>| team.is_some_and(|team| state.foreign_teams.iter().any(|t| t == team));
    match parts.as_slice() {
        ["user"] => (
            200,
            json!({ "user": { "id": 81_234_567, "username": state.user, "email": "dima@example.com" } }),
        ),
        ["team"] => (
            200,
            json!({ "teams": state.teams.iter().map(|(id, name)| json!({ "id": id, "name": name, "members": [] })).collect::<Vec<_>>() }),
        ),
        ["team", team, "space"] => {
            if foreign(Some(team)) || !state.teams.iter().any(|(id, _)| id == team) {
                return error(401, "Team not authorized", "OAUTH_027");
            }
            let spaces: Vec<Value> = state
                .spaces
                .iter()
                .filter(|space| space.parent == *team && !space.archived)
                .map(|space| json!({ "id": space.id, "name": space.name }))
                .collect();
            (200, json!({ "spaces": spaces }))
        }
        ["space", id, "folder"] => {
            let folders: Vec<Value> = state
                .folders
                .iter()
                .filter(|folder| folder.parent == *id && !folder.archived)
                .map(|folder| {
                    let lists: Vec<Value> = state
                        .lists
                        .iter()
                        .filter(|list| list.folder.as_deref() == Some(folder.id.as_str()))
                        .map(|list| list_json(state, list))
                        .collect();
                    json!({ "id": folder.id, "name": folder.name, "hidden": false, "lists": lists })
                })
                .collect();
            (200, json!({ "folders": folders }))
        }
        ["space", id, "list"] => {
            let lists: Vec<Value> = state
                .lists
                .iter()
                .filter(|list| list.parent == *id && list.folder.is_none() && !list.archived)
                .map(|list| list_json(state, list))
                .collect();
            (200, json!({ "lists": lists }))
        }
        ["folder", id, "list"] => {
            let lists: Vec<Value> = state
                .lists
                .iter()
                .filter(|list| list.folder.as_deref() == Some(*id) && !list.archived)
                .map(|list| list_json(state, list))
                .collect();
            (200, json!({ "lists": lists }))
        }
        ["space", id] => match state.space(id) {
            None => error(404, "Space not found", "PROJ_005"),
            Some(space) if foreign(Some(&space.parent)) => {
                error(401, "Team not authorized", "OAUTH_027")
            }
            Some(space) => (
                200,
                json!({ "id": space.id, "name": space.name, "archived": space.archived }),
            ),
        },
        ["folder", id] => match state.folder(id) {
            None => error(404, "Folder not found", "PROJ_005"),
            Some(folder) if foreign(state.team_of_space(&folder.parent)) => {
                error(401, "Team not authorized", "OAUTH_027")
            }
            Some(folder) => (
                200,
                json!({ "id": folder.id, "name": folder.name, "archived": folder.archived, "lists": [] }),
            ),
        },
        ["list", id] => match state.list(id) {
            None => error(404, "List not found", "SUBCAT_016"),
            Some(list) if foreign(state.team_of_space(&list.parent)) => {
                error(401, "Team not authorized", "OAUTH_027")
            }
            Some(list) => (200, list_json(state, list)),
        },
        ["team", team, "task"] => {
            if foreign(Some(team)) || !state.teams.iter().any(|(id, _)| id == team) {
                return error(401, "Team not authorized", "OAUTH_027");
            }
            let spaces = params(query, "space_ids[]");
            let folders = params(query, "project_ids[]");
            let lists = params(query, "list_ids[]");
            let include_closed = params(query, "include_closed") == ["true"];
            let subtasks = params(query, "subtasks") == ["true"];
            let page: usize = params(query, "page")
                .first()
                .and_then(|page| page.parse().ok())
                .unwrap_or(0);
            let mut tasks: Vec<&FakeTask> = state
                .tasks
                .iter()
                .filter(|task| !task.archived && (include_closed || !task.closed))
                .filter(|task| subtasks || task.parent.is_none())
                .filter(|task| {
                    let Some(list) = state.list(&task.list) else {
                        return false;
                    };
                    state.team_of_space(&list.parent) == Some(*team)
                        && (lists.contains(&list.id.as_str())
                            || list
                                .folder
                                .as_deref()
                                .is_some_and(|folder| folders.contains(&folder))
                            || spaces.contains(&list.parent.as_str()))
                })
                .collect();
            tasks.sort_by_key(|task| std::cmp::Reverse(task.updated));
            let start = (page * PAGE).min(tasks.len());
            let end = (start + PAGE).min(tasks.len());
            let page_tasks: Vec<Value> = tasks[start..end]
                .iter()
                .map(|task| state.task_json(task, false))
                .collect();
            (
                200,
                json!({ "tasks": page_tasks, "last_page": end >= tasks.len() }),
            )
        }
        ["task", id] => match state.tasks.iter().find(|task| task.id == *id) {
            None => error(404, "Task not found", "ITEM_013"),
            Some(task) => {
                let team = state
                    .list(&task.list)
                    .and_then(|list| state.team_of_space(&list.parent));
                if foreign(team) {
                    return error(401, "Team not authorized", "OAUTH_027");
                }
                let subtasks = params(query, "include_subtasks") == ["true"];
                (200, state.task_json(task, subtasks))
            }
        },
        ["task", id, "comment"] => match state.tasks.iter().find(|task| task.id == *id) {
            None => error(404, "Task not found", "ITEM_013"),
            Some(task) => {
                let start: Option<u64> =
                    params(query, "start").first().and_then(|s| s.parse().ok());
                let mut newest_first: Vec<&FakeComment> = task.comments.iter().rev().collect();
                if let Some(start) = start {
                    newest_first.retain(|comment| comment.date < start);
                }
                let comments: Vec<Value> = newest_first
                    .into_iter()
                    .take(COMMENT_PAGE)
                    .map(|comment| {
                        json!({
                            "id": comment.id,
                            "comment_text": comment.text,
                            "user": { "id": 1, "username": comment.author },
                            "date": comment.date.to_string(),
                        })
                    })
                    .collect();
                (200, json!({ "comments": comments }))
            }
        },
        _ => error(404, "Route not found", "APP_001"),
    }
}
