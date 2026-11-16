//! Item 3b (Windows, compile-checked only): "is the mic used by someone other than us?"
//!
//! Primary: for every active capture endpoint, IAudioSessionManager2 -> IAudioSessionEnumerator,
//! a session in AudioSessionStateActive whose PID != ours (and != system sounds) = someone records.
//! Alternative (`--registry`): CapabilityAccessManager ConsentStore\microphone, LastUsedTimeStop == 0
//! means "in use right now" (also covers apps that bypass the shared-mode session model).
//!
//! Prototype polls; production would use IAudioSessionNotification (new sessions) +
//! IAudioSessionEvents::OnStateChanged (per session) instead.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use anyhow::Result;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, S_OK};
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, eCapture,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows::core::{HSTRING, Interface, PWSTR};

use crate::Args;

fn exe_name(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return "?".into();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        CloseHandle(h).ok();
        if r.is_ok() { String::from_utf16_lossy(&buf[..len as usize]) } else { "?".into() }
    }
}

/// (endpoint name, pid, exe) for every *active* capture session not owned by us.
fn active_capture_sessions(own_pid: u32) -> Result<BTreeSet<(String, u32, String)>> {
    let mut out = BTreeSet::new();
    let en: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let devices = unsafe { en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)? };
    for i in 0..unsafe { devices.GetCount()? } {
        let dev = unsafe { devices.Item(i)? };
        let name = unsafe {
            dev.OpenPropertyStore(STGM_READ)
                .and_then(|ps| ps.GetValue(&PKEY_Device_FriendlyName))
                .and_then(|pv| PropVariantToStringAlloc(&pv))
                .map(|p| {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0.cast()));
                    s
                })
                .unwrap_or_else(|_| "?".into())
        };
        let mgr: IAudioSessionManager2 = unsafe { dev.Activate(CLSCTX_ALL, None)? };
        let sessions = unsafe { mgr.GetSessionEnumerator()? };
        for j in 0..unsafe { sessions.GetCount()? } {
            let ctl = unsafe { sessions.GetSession(j)? };
            if unsafe { ctl.GetState()? } != AudioSessionStateActive {
                continue;
            }
            let ctl2: IAudioSessionControl2 = ctl.cast()?;
            if unsafe { ctl2.IsSystemSoundsSession() } == S_OK {
                continue;
            }
            let pid = unsafe { ctl2.GetProcessId() }.unwrap_or(0); // multi-process sessions return an error
            if pid == own_pid {
                continue;
            }
            out.insert((name.clone(), pid, exe_name(pid)));
        }
    }
    Ok(out)
}

/// ConsentStore entries with LastUsedTimeStop == 0 (= mic in use now) under HKCU.
fn registry_in_use() -> Vec<String> {
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    let mut found = Vec::new();
    let scan = |path: &str, found: &mut Vec<String>| unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), None, KEY_READ, &mut key) != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut subkeys = Vec::new();
        for idx in 0.. {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            if RegEnumKeyExW(key, idx, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) != ERROR_SUCCESS {
                break;
            }
            let sub = String::from_utf16_lossy(&buf[..len as usize]);
            let mut skey = HKEY::default();
            if RegOpenKeyExW(key, &HSTRING::from(sub.as_str()), None, KEY_READ, &mut skey) == ERROR_SUCCESS {
                let mut stop = 0u64;
                let mut start = 0u64;
                let mut sz = 8u32;
                let has_stop = RegQueryValueExW(skey, &HSTRING::from("LastUsedTimeStop"), None, None, Some((&raw mut stop).cast()), Some(&mut sz)) == ERROR_SUCCESS;
                sz = 8;
                let _ = RegQueryValueExW(skey, &HSTRING::from("LastUsedTimeStart"), None, None, Some((&raw mut start).cast()), Some(&mut sz));
                if has_stop && stop == 0 && start != 0 {
                    found.push(sub.replace('#', "\\"));
                }
                let _ = RegCloseKey(skey);
            }
            subkeys.push(sub);
        }
        let _ = RegCloseKey(key);
        subkeys
    };
    scan(BASE, &mut found); // packaged (Store) apps
    scan(&format!(r"{BASE}\NonPackaged"), &mut found); // classic Win32 apps, path with '#' separators
    found
}

pub fn run(a: &Args) -> Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let own_pid = std::process::id();
    let secs = a.f64("--secs", 0.0)?;
    let poll = Duration::from_millis(a.f64("--poll-ms", 200.0)? as u64);
    let t0 = Instant::now();
    let mut last: Option<BTreeSet<(String, u32, String)>> = None;
    let mut last_reg: Option<Vec<String>> = None;
    loop {
        let now = active_capture_sessions(own_pid)?;
        if last.as_ref() != Some(&now) {
            println!("{:>8.0} ms  OTHERS_USING_MIC={}  sessions={now:?}", t0.elapsed().as_secs_f64() * 1e3, !now.is_empty());
            last = Some(now);
        }
        if a.flag("--registry") {
            let reg = registry_in_use();
            if last_reg.as_ref() != Some(&reg) {
                println!("{:>8.0} ms  registry LastUsedTimeStop==0: {reg:?}", t0.elapsed().as_secs_f64() * 1e3);
                last_reg = Some(reg);
            }
        }
        if t0.elapsed().as_secs_f64() >= secs {
            break;
        }
        std::thread::sleep(poll);
    }
    Ok(())
}
