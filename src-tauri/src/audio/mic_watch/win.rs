//! Windows (compile-checked only, like the spike): who captures from an
//! input, from the audio sessions of every active capture endpoint
//! (design.md, decision 3), after `spikes/audio/src/win/mic_sessions.rs`.
//!
//! Polled every 500 ms on this thread, in the COM MTA. A session holds the
//! input when it is `AudioSessionStateActive`, isn't the system sounds
//! session and its process isn't in our process tree (WebView2 runs in
//! child processes of the app).

use std::{
    collections::HashMap,
    ffi::c_void,
    time::{Duration, Instant},
};

use windows::{
    Win32::{
        Foundation::{CloseHandle, S_OK},
        Media::Audio::{
            AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionControl2,
            IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
        },
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
        System::{
            Com::{
                CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
    },
    core::{HSTRING, Interface, PWSTR},
};

use super::{
    Driver, Woken,
    names::{in_process_tree, windows_app_name},
    state::Holder,
};

const POLL: Duration = Duration::from_millis(500);

pub(super) fn run(driver: &Driver) {
    // SAFETY: a new thread joins the MTA once and leaves it at the end.
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        eprintln!("grill: mic watcher: COM: {error}");
        return;
    }
    watch(driver);
    // SAFETY: pairs the CoInitializeEx above; every COM object is dropped.
    unsafe { CoUninitialize() };
}

fn watch(driver: &Driver) {
    // SAFETY: a COM call in the MTA.
    let enumerator: IMMDeviceEnumerator =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(enumerator) => enumerator,
            Err(error) => {
                eprintln!("grill: mic watcher: device enumerator: {error}");
                return;
            }
        };
    let own_pid = std::process::id();
    let mut names: HashMap<u32, String> = HashMap::new();
    loop {
        match capturing_pids(&enumerator) {
            Ok(pids) => {
                let holders = holders(&pids, own_pid, &mut names);
                driver.observe(&holders);
            }
            // Nothing is known, which is not "free": the debouncer only ticks.
            Err(error) => eprintln!("grill: mic watcher: sessions: {error}"),
        }
        if driver.wait(Instant::now() + POLL) == Woken::Stop {
            break;
        }
    }
}

/// Pids of the active, non-system capture sessions on every active input.
/// An endpoint or session that fails (unplugged mid-scan) is skipped.
fn capturing_pids(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<Vec<u32>> {
    let mut pids = Vec::new();
    // SAFETY: COM calls in the MTA on live interfaces.
    unsafe {
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        for index in 0..devices.GetCount()? {
            let Ok(device) = devices.Item(index) else {
                continue;
            };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else {
                continue;
            };
            for session in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(control) = sessions.GetSession(session) else {
                    continue;
                };
                if control.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(control) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                if control.IsSystemSoundsSession() == S_OK {
                    continue;
                }
                if let Ok(pid) = control.GetProcessId()
                    && pid != 0
                    && !pids.contains(&pid)
                {
                    pids.push(pid);
                }
            }
        }
    }
    Ok(pids)
}

/// The foreign holders among `pids`, named; `names` caches the names of
/// the pids seen in the last scan.
fn holders(pids: &[u32], own_pid: u32, names: &mut HashMap<u32, String>) -> Vec<Holder> {
    names.retain(|pid, _| pids.contains(pid));
    if pids.is_empty() {
        return Vec::new();
    }
    let table = process_table();
    let parents: HashMap<u32, u32> = table
        .iter()
        .map(|(pid, entry)| (*pid, entry.parent))
        .collect();
    pids.iter()
        .filter(|pid| !in_process_tree(**pid, own_pid, &parents))
        .map(|pid| Holder {
            pid: *pid,
            app: names
                .entry(*pid)
                .or_insert_with(|| app_name(*pid, table.get(pid)))
                .clone(),
        })
        .collect()
}

struct TableEntry {
    parent: u32,
    exe: String,
}

/// Every process with its parent and exe file name.
fn process_table() -> HashMap<u32, TableEntry> {
    let mut table = HashMap::new();
    // SAFETY: a process snapshot, read with a sized entry and closed.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return table;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or(0),
            ..PROCESSENTRY32W::default()
        };
        let mut more = Process32FirstW(snapshot, &raw mut entry).is_ok();
        while more {
            let length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            table.insert(
                entry.th32ProcessID,
                TableEntry {
                    parent: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..length]),
                },
            );
            more = Process32NextW(snapshot, &raw mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    table
}

fn app_name(pid: u32, entry: Option<&TableEntry>) -> String {
    let path = image_path(pid);
    let description = path.as_deref().and_then(file_description);
    let file = path.or_else(|| entry.map(|entry| entry.exe.clone()));
    windows_app_name(description.as_deref(), file.as_deref().unwrap_or_default())
        .unwrap_or_else(|| format!("pid {pid}"))
}

fn image_path(pid: u32) -> Option<String> {
    // SAFETY: a limited query handle, closed after one call.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = u32::try_from(buffer.len()).unwrap_or(0);
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(
            &buffer[..usize::try_from(length).unwrap_or(0).min(buffer.len())],
        ))
    }
}

/// `FileDescription` from the exe's version resource, in its first
/// language, else US English.
fn file_description(path: &str) -> Option<String> {
    const US_ENGLISH_UNICODE: (u16, u16) = (0x0409, 0x04B0);
    let file = HSTRING::from(path);
    // SAFETY: the version block is read into a buffer of the size asked
    // for (u16 for alignment); `VerQueryValueW` points into it.
    unsafe {
        let size = GetFileVersionInfoSizeW(&file, None);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u16; usize::try_from(size).ok()?.div_ceil(2)];
        GetFileVersionInfoW(&file, None, size, block.as_mut_ptr().cast()).ok()?;
        let block = block.as_ptr().cast::<c_void>();

        let mut languages = Vec::new();
        if let Some((pointer, length)) = query(block, "\\VarFileInfo\\Translation") {
            let count = usize::try_from(length).unwrap_or(0) / size_of::<[u16; 2]>();
            for index in 0..count {
                let [language, code_page] =
                    std::ptr::read_unaligned(pointer.cast::<[u16; 2]>().add(index));
                languages.push((language, code_page));
            }
        }
        languages.push(US_ENGLISH_UNICODE);
        languages.into_iter().find_map(|(language, code_page)| {
            let key = format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\FileDescription");
            let (pointer, length) = query(block, &key)?;
            let units =
                std::slice::from_raw_parts(pointer.cast::<u16>(), usize::try_from(length).ok()?);
            let end = units
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(units.len());
            let text = String::from_utf16_lossy(&units[..end]);
            (!text.trim().is_empty()).then_some(text)
        })
    }
}

/// A value of a version block: its pointer and length (characters for
/// strings, bytes otherwise).
///
/// # Safety
/// `block` is a block from `GetFileVersionInfoW`, alive while the result
/// is used.
unsafe fn query(block: *const c_void, key: &str) -> Option<(*const c_void, u32)> {
    let mut pointer: *mut c_void = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: per the contract above.
    let found = unsafe {
        VerQueryValueW(
            block,
            &HSTRING::from(key),
            &raw mut pointer,
            &raw mut length,
        )
    };
    (found.as_bool() && !pointer.is_null() && length > 0).then_some((pointer.cast_const(), length))
}
