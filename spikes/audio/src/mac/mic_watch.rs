//! Item 1: "is the microphone used by someone other than us?" on macOS 14+.
//!
//! Event-driven: listeners on
//!   - system object: kAudioHardwarePropertyProcessObjectList (process appears / goes away)
//!   - each process object: kAudioProcessPropertyIsRunningInput
//!   - default input device: kAudioDevicePropertyDeviceIsRunningSomewhere (cannot tell us from others)
//! An optional poller runs alongside to measure how late the listeners are.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::process::{Child, Command};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use objc2_core_audio::{AudioObjectAddPropertyListener, AudioObjectID, AudioObjectPropertyAddress, AudioObjectRemovePropertyListener};

use super::hal::*;

static T0: OnceLock<Instant> = OnceLock::new();
static STATE: Mutex<Option<State>> = Mutex::new(None);

fn ms() -> f64 {
    T0.get().unwrap().elapsed().as_secs_f64() * 1000.0
}

#[derive(Debug, Clone)]
struct Proc {
    pid: i32,
    bundle: String,
    running_input: bool,
}

#[derive(Default)]
struct State {
    own_pid: i32,
    procs: HashMap<AudioObjectID, Proc>,
    listened: HashSet<AudioObjectID>,
    others_using_mic: bool,
    device_running_somewhere: bool,
    /// (time ms, source, value) of aggregate transitions, for the summary.
    events: Vec<(f64, &'static str, bool)>,
}

impl State {
    fn recompute(&mut self, source: &'static str) {
        let now = self
            .procs
            .values()
            .any(|p| p.running_input && p.pid != self.own_pid);
        if now != self.others_using_mic {
            self.others_using_mic = now;
            let who: Vec<String> = self
                .procs
                .values()
                .filter(|p| p.running_input && p.pid != self.own_pid)
                .map(|p| format!("{}({})", p.bundle, p.pid))
                .collect();
            println!(
                "{:>9.1} ms  OTHERS_USING_MIC={now}  via {source}  holders={who:?}",
                ms()
            );
            self.events.push((ms(), "others", now));
        }
    }
}

fn read_proc(obj: AudioObjectID) -> Option<Proc> {
    let pid: i32 = get(obj, PROC_PID, SCOPE_GLOBAL).ok()?;
    let bundle = get_string(obj, PROC_BUNDLE_ID, SCOPE_GLOBAL).unwrap_or_default();
    let running: u32 = get(obj, PROC_IS_RUNNING_INPUT, SCOPE_GLOBAL).unwrap_or(0);
    let bundle = if bundle.is_empty() { proc_name(pid) } else { bundle };
    Some(Proc { pid, bundle, running_input: running != 0 })
}

fn proc_name(pid: i32) -> String {
    let mut buf = [0u8; 256];
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n > 0 {
        format!("<{}>", String::from_utf8_lossy(&buf[..n as usize]))
    } else {
        "<?>".into()
    }
}

unsafe extern "C-unwind" fn on_process_list(
    _obj: AudioObjectID,
    _n: u32,
    _addrs: NonNull<AudioObjectPropertyAddress>,
    _ctx: *mut c_void,
) -> i32 {
    refresh_process_list("listener:process-list");
    0
}

static PROC_LISTEN: OnceLock<AudioObjectPropertyAddress> = OnceLock::new();

unsafe extern "C-unwind" fn on_proc_running_input(
    obj: AudioObjectID,
    n: u32,
    addrs: NonNull<AudioObjectPropertyAddress>,
    _ctx: *mut c_void,
) -> i32 {
    if std::env::var_os("SPIKE_DEBUG").is_some() {
        let list = unsafe { std::slice::from_raw_parts(addrs.as_ptr(), n as usize) };
        let sel: Vec<String> = list.iter().map(|a| format!("{}/{}/{}", cc_str(a.mSelector), cc_str(a.mScope), a.mElement)).collect();
        println!("{:>9.1} ms  [debug] process obj={obj} notified: {sel:?}", ms());
    }
    let running: u32 = get(obj, PROC_IS_RUNNING_INPUT, SCOPE_GLOBAL).unwrap_or(0);
    let mut g = STATE.lock().unwrap();
    let st = g.as_mut().unwrap();
    if let Some(p) = st.procs.get_mut(&obj) {
        p.running_input = running != 0;
        let devs: Vec<String> = get_vec::<AudioObjectID>(obj, PROC_DEVICES, SCOPE_INPUT)
            .unwrap_or_default()
            .into_iter()
            .map(device_name)
            .collect();
        println!(
            "{:>9.1} ms  process {} pid={} IsRunningInput={} input-devices={devs:?}{}",
            ms(),
            p.bundle,
            p.pid,
            running != 0,
            if p.pid == st.own_pid { "  (self, ignored)" } else { "" }
        );
    }
    st.recompute("listener:IsRunningInput");
    0
}

unsafe extern "C-unwind" fn on_device_running(
    obj: AudioObjectID,
    _n: u32,
    _addrs: NonNull<AudioObjectPropertyAddress>,
    _ctx: *mut c_void,
) -> i32 {
    let v: u32 = get(obj, DEV_IS_RUNNING_SOMEWHERE, SCOPE_GLOBAL).unwrap_or(0);
    let mut g = STATE.lock().unwrap();
    let st = g.as_mut().unwrap();
    if st.device_running_somewhere != (v != 0) {
        st.device_running_somewhere = v != 0;
        println!("{:>9.1} ms  input-device DeviceIsRunningSomewhere={}", ms(), v != 0);
        st.events.push((ms(), "device", v != 0));
    }
    0
}

fn refresh_process_list(source: &'static str) {
    let objs: Vec<AudioObjectID> = get_vec(SYSTEM, HW_PROCESS_OBJECT_LIST, SCOPE_GLOBAL).unwrap_or_default();
    let mut g = STATE.lock().unwrap();
    let st = g.as_mut().unwrap();
    let current: HashSet<AudioObjectID> = objs.iter().copied().collect();
    for obj in &objs {
        if st.listened.insert(*obj) {
            // macOS 26.6 (M3) observation: no notification is posted for 'piri' itself; the change
            // arrives as kAudioProcessPropertyDevices ('pdv#', input scope). Listen to both.
            let mut a = *PROC_LISTEN.get().unwrap();
            let mut b = addr(PROC_DEVICES, SCOPE_INPUT);
            unsafe {
                AudioObjectAddPropertyListener(*obj, NonNull::from(&mut a), Some(on_proc_running_input), std::ptr::null_mut());
                if std::env::var_os("SPIKE_ONLY_PIRI").is_none() {
                    AudioObjectAddPropertyListener(*obj, NonNull::from(&mut b), Some(on_proc_running_input), std::ptr::null_mut());
                }
            }
            if let Some(p) = read_proc(*obj) {
                if T0.get().unwrap().elapsed() > Duration::from_millis(50) {
                    println!(
                        "{:>9.1} ms  + process obj={obj} {} pid={} running_input={}",
                        ms(),
                        p.bundle,
                        p.pid,
                        p.running_input
                    );
                }
                st.procs.insert(*obj, p);
            }
        }
    }
    let gone: Vec<AudioObjectID> = st.listened.difference(&current).copied().collect();
    for obj in gone {
        st.listened.remove(&obj);
        if let Some(p) = st.procs.remove(&obj) {
            println!("{:>9.1} ms  - process obj={obj} {} pid={} (gone)", ms(), p.bundle, p.pid);
        }
    }
    st.recompute(source);
}

pub struct Opts {
    pub secs: f64,
    pub poll_ms: u64,
    pub spawn: Option<String>,
    pub spawn_at: f64,
    pub kill_after: Option<f64>,
    pub self_capture: Option<f64>,
    /// Device to watch with DeviceIsRunningSomewhere (default: system default input).
    pub device: Option<String>,
}

pub fn run(o: Opts) -> Result<()> {
    T0.set(Instant::now()).ok();
    // '****' = kAudioObjectPropertySelectorWildcard / ScopeWildcard, 0xFFFFFFFF = ElementWildcard.
    let sel = std::env::var("SPIKE_PROC_SELECTOR").ok().map_or(PROC_IS_RUNNING_INPUT, |s| fourcc(s.as_bytes().try_into().expect("4 chars")));
    let wildcard_scope = std::env::var_os("SPIKE_WILDCARD_SCOPE").is_some();
    PROC_LISTEN
        .set(AudioObjectPropertyAddress {
            mSelector: sel,
            mScope: if wildcard_scope { fourcc(b"****") } else { SCOPE_GLOBAL },
            mElement: if wildcard_scope { u32::MAX } else { ELEMENT_MAIN },
        })
        .ok();
    println!("per-process listener on '{}' (wildcard scope/element: {wildcard_scope})", cc_str(sel));
    use_hal_notification_thread()?;
    let own_pid = std::process::id() as i32;
    let input = match &o.device {
        Some(n) => find_device(n, SCOPE_INPUT)?,
        None => default_input()?,
    };
    let running: u32 = get(input, DEV_IS_RUNNING_SOMEWHERE, SCOPE_GLOBAL).unwrap_or(0);
    *STATE.lock().unwrap() = Some(State {
        own_pid,
        device_running_somewhere: running != 0,
        ..Default::default()
    });
    println!(
        "own pid={own_pid}; watched input device: {} (id {input}); DeviceIsRunningSomewhere={}",
        device_name(input),
        running != 0
    );

    let mut a = addr(HW_PROCESS_OBJECT_LIST, SCOPE_GLOBAL);
    unsafe { AudioObjectAddPropertyListener(SYSTEM, NonNull::from(&mut a), Some(on_process_list), std::ptr::null_mut()) };
    let mut d = addr(DEV_IS_RUNNING_SOMEWHERE, SCOPE_GLOBAL);
    unsafe { AudioObjectAddPropertyListener(input, NonNull::from(&mut d), Some(on_device_running), std::ptr::null_mut()) };
    refresh_process_list("initial");
    {
        let g = STATE.lock().unwrap();
        let st = g.as_ref().unwrap();
        println!("initial: {} audio client processes", st.procs.len());
        for (obj, p) in &st.procs {
            if p.running_input {
                println!("   input running: obj={obj} {} pid={}", p.bundle, p.pid);
            }
        }
        println!("initial OTHERS_USING_MIC={}", st.others_using_mic);
    }

    // Optional poller for comparison with listener latency.
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let poll_events = std::sync::Arc::new(Mutex::new(Vec::<(f64, &'static str, bool)>::new()));
    let poller = (o.poll_ms > 0).then(|| {
        let stop = stop.clone();
        let pe = poll_events.clone();
        std::thread::spawn(move || poll_loop(own_pid, input, o.poll_ms, &stop, &pe))
    });

    let mut child: Option<(Child, f64)> = None;
    let mut child_exit: Option<f64> = None;
    let mut killed = false;
    let mut self_cap: Option<super::au::Capture> = None;
    let mut self_cap_stopped = false;
    let deadline = Duration::from_secs_f64(o.secs);
    while T0.get().unwrap().elapsed() < deadline {
        let t = T0.get().unwrap().elapsed().as_secs_f64();
        if let Some(cmd) = &o.spawn
            && child.is_none()
            && child_exit.is_none()
            && t >= o.spawn_at
        {
            let c = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("exec {cmd}"))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;
            println!("{:>9.1} ms  >>> spawned pid={} : {cmd}", ms(), c.id());
            child = Some((c, ms()));
        }
        if let Some((c, spawned)) = &mut child {
            if let Some(k) = o.kill_after
                && !killed
                && ms() - *spawned >= k * 1000.0
            {
                unsafe { libc::kill(c.id() as i32, libc::SIGKILL) };
                println!("{:>9.1} ms  >>> SIGKILL pid={}", ms(), c.id());
                killed = true;
            }
            if let Some(status) = c.try_wait()? {
                println!("{:>9.1} ms  >>> child exited: {status}", ms());
                child_exit = Some(ms());
            }
        }
        if child_exit.is_some()
            && let Some((c, spawned)) = child.take()
        {
            summarize(c.id() as i32, spawned, child_exit.unwrap(), &poll_events);
        }
        if let Some(sc) = o.self_capture {
            if self_cap.is_none() && !self_cap_stopped && t >= 0.5 {
                println!("{:>9.1} ms  >>> self: starting own mic capture (should NOT flip OTHERS_USING_MIC)", ms());
                self_cap = Some(super::au::Capture::start(super::au::Mode::Raw, Some(input), None)?);
            }
            if self_cap.is_some() && t >= 0.5 + sc {
                self_cap.take().unwrap().stop();
                self_cap_stopped = true;
                println!("{:>9.1} ms  >>> self: stopped own mic capture", ms());
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    if let Some((mut c, _)) = child.take() {
        c.kill().ok();
        c.wait().ok();
        println!("child still running at deadline: killed");
    }
    drop(self_cap);
    stop.store(true, Ordering::SeqCst);
    if let Some(p) = poller {
        p.join().ok();
    }
    unsafe {
        AudioObjectRemovePropertyListener(SYSTEM, NonNull::from(&mut a), Some(on_process_list), std::ptr::null_mut());
        AudioObjectRemovePropertyListener(input, NonNull::from(&mut d), Some(on_device_running), std::ptr::null_mut());
    }
    Ok(())
}

fn poll_loop(own_pid: i32, input: AudioObjectID, period_ms: u64, stop: &AtomicBool, out: &Mutex<Vec<(f64, &'static str, bool)>>) {
    let mut last_others: Option<bool> = None;
    let mut last_dev: Option<bool> = None;
    while !stop.load(Ordering::SeqCst) {
        let objs: Vec<AudioObjectID> = get_vec(SYSTEM, HW_PROCESS_OBJECT_LIST, SCOPE_GLOBAL).unwrap_or_default();
        let others = objs.iter().any(|o| {
            let pid: i32 = get(*o, PROC_PID, SCOPE_GLOBAL).unwrap_or(0);
            let r: u32 = get(*o, PROC_IS_RUNNING_INPUT, SCOPE_GLOBAL).unwrap_or(0);
            r != 0 && pid != own_pid
        });
        let dev = get::<u32>(input, DEV_IS_RUNNING_SOMEWHERE, SCOPE_GLOBAL).unwrap_or(0) != 0;
        if last_others.is_some_and(|l| l != others) {
            println!("{:>9.1} ms  [poll {period_ms}ms] others={others}", ms());
            out.lock().unwrap().push((ms(), "others", others));
        }
        if last_dev.is_some_and(|l| l != dev) {
            println!("{:>9.1} ms  [poll {period_ms}ms] device-running-somewhere={dev}", ms());
            out.lock().unwrap().push((ms(), "device", dev));
        }
        last_others = Some(others);
        last_dev = Some(dev);
        std::thread::sleep(Duration::from_millis(period_ms));
    }
}

fn summarize(pid: i32, spawned: f64, exited: f64, poll: &Mutex<Vec<(f64, &'static str, bool)>>) {
    let g = STATE.lock().unwrap();
    let st = g.as_ref().unwrap();
    let find = |evs: &[(f64, &'static str, bool)], kind: &str, val: bool, after: f64| {
        evs.iter().find(|(t, k, v)| *k == kind && *v == val && *t >= after - 1.0).map(|e| e.0)
    };
    let pe = poll.lock().unwrap();
    println!("---- summary for child pid={pid}: spawned at {spawned:.1} ms, exited at {exited:.1} ms");
    for (label, evs) in [("listener", &st.events[..]), ("poller", &pe[..])] {
        for kind in ["others", "device"] {
            let on = find(evs, kind, true, spawned);
            let off = on.and_then(|t| find(evs, kind, false, t));
            println!(
                "  {label:<8} {kind:<7} on: {}   off: {}",
                on.map_or("-".into(), |t| format!("+{:.1} ms after spawn", t - spawned)),
                off.map_or("-".into(), |t| format!("{:+.1} ms vs child exit", t - exited)),
            );
        }
    }
}
