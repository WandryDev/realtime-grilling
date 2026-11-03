//! Which audio clients are ours: this process and the system services
//! working for it (the WebKit GPU and WebContent processes of our webview).

use std::{ffi::c_int, sync::OnceLock};

use objc2_core_audio::AudioObjectID;

use super::hal::{self, HW_PROCESS_OBJECT_LIST, PROC_PID, SCOPE_GLOBAL, SYSTEM};

/// `pid_t responsibility_get_pid_responsible_for_pid(pid_t)`, private.
type Responsible = unsafe extern "C" fn(c_int) -> c_int;

fn responsible_function() -> Option<Responsible> {
    static FUNCTION: OnceLock<Option<usize>> = OnceLock::new();
    let address = *FUNCTION.get_or_init(|| {
        // SAFETY: dlsym with a NUL-terminated name over the loaded images.
        let symbol = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        (!symbol.is_null()).then_some(symbol as usize)
    });
    // SAFETY: the symbol has this signature.
    address.map(|address| unsafe { std::mem::transmute::<usize, Responsible>(address) })
}

/// The process macOS holds responsible for `pid` (Safari for its WebKit
/// GPU service), if the private SPI exists.
pub fn responsible_pid(pid: i32) -> Option<i32> {
    let function = responsible_function()?;
    // SAFETY: takes and returns a pid; no other effects.
    let responsible = unsafe { function(pid) };
    (responsible > 0).then_some(responsible)
}

/// The process objects among `clients` (object, pid) that are ours: our
/// pid, or one macOS holds us responsible for.
pub fn ours(
    clients: &[(AudioObjectID, i32)],
    own_pid: i32,
    responsible: impl Fn(i32) -> Option<i32>,
) -> Vec<AudioObjectID> {
    clients
        .iter()
        .filter(|(_, pid)| *pid == own_pid || responsible(*pid) == Some(own_pid))
        .map(|(object, _)| *object)
        .collect()
}

/// The HAL process objects of this app now. Empty when the list can't be
/// read.
pub fn own_process_objects() -> Vec<AudioObjectID> {
    let own_pid = i32::try_from(std::process::id()).unwrap_or(0);
    let objects: Vec<AudioObjectID> =
        hal::get_vec(SYSTEM, HW_PROCESS_OBJECT_LIST, SCOPE_GLOBAL).unwrap_or_default();
    let clients: Vec<(AudioObjectID, i32)> = objects
        .into_iter()
        .filter_map(|object| {
            let pid = hal::get::<i32>(object, PROC_PID, SCOPE_GLOBAL).ok()?;
            Some((object, pid))
        })
        .collect();
    ours(&clients, own_pid, responsible_pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_pid_and_the_services_working_for_us_are_ours() {
        let own = 100;
        // 7: our process, 8: our WebKit GPU process, 9: Zoom, 10: Safari's
        // GPU process.
        let clients = [(7, own), (8, 200), (9, 300), (10, 400)];
        let responsible = |pid| match pid {
            200 => Some(own),
            400 => Some(500),
            300 => None,
            _ => Some(pid),
        };
        assert_eq!(ours(&clients, own, responsible), [7, 8]);
    }

    #[test]
    fn this_process_is_responsible_for_itself_or_unknown() {
        let own = i32::try_from(std::process::id()).unwrap();
        assert!(matches!(responsible_pid(own), None | Some(_)));
        let objects = own_process_objects();
        // Not an audio client in the test unless something opened a device.
        assert!(objects.len() <= 16, "{objects:?}");
    }
}
