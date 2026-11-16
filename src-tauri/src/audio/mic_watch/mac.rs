//! macOS: who captures from an input, from the HAL's process objects
//! (design.md, decisions 1–2), after `spikes/audio/src/mac/mic_watch.rs`.
//!
//! Listeners on `prs#` (process objects come and go) of the system object
//! and on `pdv#` (input scope; macOS 26 posts the change there) and `piri`
//! of every process object wake the thread, which then re-reads
//! `IsRunningInput` of all of them. A full re-scan every 2 s covers a
//! listener lost with its device.

use std::{
    collections::HashMap,
    ffi::c_void,
    ptr::NonNull,
    sync::{Mutex, PoisonError, mpsc::Sender},
    time::{Duration, Instant},
};

use objc2_core_audio::{AudioObjectID, AudioObjectPropertyAddress};

use super::{Driver, Signal, Woken, names::outermost_app, state::Holder};
use crate::audio::mac::{
    hal::{
        self, HW_PROCESS_OBJECT_LIST, PROC_DEVICES, PROC_IS_RUNNING_INPUT, PROC_PID, SCOPE_GLOBAL,
        SCOPE_INPUT, SYSTEM,
    },
    process::responsible_pid,
};

/// The safety net re-scan.
const POLL: Duration = Duration::from_secs(2);

/// The listeners on every process object.
const PROCESS_PROPERTIES: [(u32, u32); 2] = [
    (PROC_DEVICES, SCOPE_INPUT),
    (PROC_IS_RUNNING_INPUT, SCOPE_GLOBAL),
];

/// Where the HAL listeners send their wake-up. A static, not the client
/// pointer: a notification already in flight when the listener is removed
/// finds `None` instead of a freed pointer.
static WAKE: Mutex<Option<Sender<Signal>>> = Mutex::new(None);

unsafe extern "C-unwind" fn on_change(
    _object: AudioObjectID,
    _count: u32,
    _addresses: NonNull<AudioObjectPropertyAddress>,
    _client: *mut c_void,
) -> i32 {
    if let Some(wake) = WAKE.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
        let _ = wake.send(Signal::Wake);
    }
    0
}

/// A process object we listen to, and its app (`None`: one of ours).
struct Process {
    holder: Option<Holder>,
}

pub(super) fn run(driver: &Driver) {
    *WAKE.lock().unwrap_or_else(PoisonError::into_inner) = Some(driver.wake.clone());
    if let Err(error) = hal::use_hal_notification_thread() {
        eprintln!("grill: mic watcher: HAL notification thread: {error}");
    }
    if let Err(error) = hal::add_listener(
        SYSTEM,
        HW_PROCESS_OBJECT_LIST,
        SCOPE_GLOBAL,
        Some(on_change),
    ) {
        eprintln!("grill: mic watcher: process list listener: {error}");
    }
    let own_pid = i32::try_from(std::process::id()).unwrap_or(0);
    let mut processes = HashMap::new();
    loop {
        if let Some(holders) = scan(&mut processes, own_pid) {
            driver.observe(&holders);
        }
        match driver.wait(Instant::now() + POLL) {
            Woken::Poll | Woken::Wake => {}
            Woken::Stop => break,
        }
    }
    *WAKE.lock().unwrap_or_else(PoisonError::into_inner) = None;
    let _ = hal::remove_listener(
        SYSTEM,
        HW_PROCESS_OBJECT_LIST,
        SCOPE_GLOBAL,
        Some(on_change),
    );
    for object in processes.keys() {
        unlisten(*object);
    }
}

fn unlisten(object: AudioObjectID) {
    for (selector, scope) in PROCESS_PROPERTIES {
        let _ = hal::remove_listener(object, selector, scope, Some(on_change));
    }
}

/// The foreign processes that capture from an input now. Listens to new
/// process objects and forgets the gone ones. `None` when the list can't be
/// read: nothing is known, which is not "free".
fn scan(processes: &mut HashMap<AudioObjectID, Process>, own_pid: i32) -> Option<Vec<Holder>> {
    let objects: Vec<AudioObjectID> =
        match hal::get_vec(SYSTEM, HW_PROCESS_OBJECT_LIST, SCOPE_GLOBAL) {
            Ok(objects) => objects,
            Err(error) => {
                eprintln!("grill: mic watcher: process list: {error}");
                return None;
            }
        };
    processes.retain(|object, _| {
        let present = objects.contains(object);
        if !present {
            unlisten(*object);
        }
        present
    });
    let mut holders = Vec::new();
    for object in objects {
        let process = processes.entry(object).or_insert_with(|| {
            for (selector, scope) in PROCESS_PROPERTIES {
                if let Err(error) = hal::add_listener(object, selector, scope, Some(on_change)) {
                    eprintln!("grill: mic watcher: listener on process {object}: {error}");
                }
            }
            Process {
                holder: hal::get::<i32>(object, PROC_PID, SCOPE_GLOBAL)
                    .ok()
                    .and_then(|pid| describe(pid, own_pid)),
            }
        });
        let running = hal::get::<u32>(object, PROC_IS_RUNNING_INPUT, SCOPE_GLOBAL)
            .is_ok_and(|running| running != 0);
        if running && let Some(holder) = &process.holder {
            holders.push(holder.clone());
        }
    }
    Some(holders)
}

/// The app of a process, `None` when it is ours: our pid, or a system
/// service working for us (the WebKit GPU process of our webview).
fn describe(pid: i32, own_pid: i32) -> Option<Holder> {
    if pid == own_pid {
        return None;
    }
    let responsible = responsible_pid(pid);
    if responsible == Some(own_pid) {
        return None;
    }
    let app = pid_path(pid)
        .as_deref()
        .and_then(outermost_app)
        .or_else(|| {
            let responsible = responsible.filter(|responsible| *responsible != pid)?;
            pid_path(responsible).as_deref().and_then(outermost_app)
        })
        .or_else(|| proc_name(pid))
        .unwrap_or_else(|| format!("pid {pid}"));
    Some(Holder {
        pid: u32::try_from(pid).unwrap_or(0),
        app,
    })
}

fn pid_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).unwrap_or(4096)];
    // SAFETY: the buffer holds `len` bytes; the call writes at most that.
    let length = unsafe {
        libc::proc_pidpath(
            pid,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).unwrap_or(0),
        )
    };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    Some(String::from_utf8_lossy(&buffer[..length]).into_owned())
}

fn proc_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: as in `pid_path`.
    let length = unsafe {
        libc::proc_name(
            pid,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).unwrap_or(0),
        )
    };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    Some(String::from_utf8_lossy(&buffer[..length]).into_owned())
}
