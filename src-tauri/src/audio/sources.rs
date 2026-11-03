//! The real devices behind the meters (decision 12): the default input
//! through `cpal`, system audio through a process tap (macOS) or loopback
//! (Windows). A capture without the access is refused up front: opening
//! the microphone before the user answered would show the prompt.

use std::{
    sync::mpsc,
    thread::{self, JoinHandle},
};

use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};

use super::{
    AudioSource,
    level::Feed,
    levels::{Opened, Opener},
    sink::{BlockFormat, SampleSink},
};
use crate::{
    error::{CaptureFailure, CommandError, CommandResult},
    permissions::{self, PermissionKind, PermissionState, PermissionStatus},
};

pub struct DeviceOpener;

impl Opener for DeviceOpener {
    fn open(&self, source: AudioSource, feed: Feed) -> CommandResult<Opened> {
        match source {
            AudioSource::Microphone => {
                ensure_access(
                    &permissions::status(PermissionKind::Microphone),
                    "микрофону",
                )?;
                open_microphone(feed)
            }
            AudioSource::System => {
                #[cfg(target_os = "macos")]
                ensure_access(
                    &permissions::status(PermissionKind::SystemAudio),
                    "записи системного звука",
                )?;
                open_system(feed)
            }
        }
    }
}

/// `granted` and `unknown` may capture (`unknown` then shows silence);
/// the others are `noAccess`.
pub fn ensure_access(status: &PermissionStatus, what: &str) -> CommandResult<()> {
    match status.state {
        PermissionState::Granted | PermissionState::Unknown => Ok(()),
        PermissionState::NotDetermined => Err(CommandError::capture(
            CaptureFailure::NoAccess,
            format!("Доступ к {what} ещё не выдан"),
        )),
        PermissionState::Denied => Err(CommandError::capture(
            CaptureFailure::NoAccess,
            status
                .message
                .clone()
                .unwrap_or_else(|| format!("Нет доступа к {what}")),
        )),
    }
}

/// The default input into `sink`. The caller checks the access first.
pub fn open_microphone(sink: impl SampleSink) -> CommandResult<Opened> {
    Ok(Opened {
        capture: Box::new(Microphone::open(sink)?),
        playing: None,
    })
}

/// What the other apps play, into `sink`. The caller checks the access
/// first (macOS).
#[cfg(target_os = "macos")]
pub fn open_system(sink: impl SampleSink) -> CommandResult<Opened> {
    use super::mac::{hal, tap::SystemTap};

    let tap = SystemTap::start(sink).map_err(|error| {
        CommandError::capture(
            CaptureFailure::Busy,
            format!("Не удалось начать запись системного звука: {error}"),
        )
    })?;
    Ok(Opened {
        capture: Box::new(tap),
        playing: Some(Box::new(hal::output_playing)),
    })
}

#[cfg(windows)]
pub fn open_system(sink: impl SampleSink) -> CommandResult<Opened> {
    let loopback = super::win::Loopback::start(sink).map_err(|error| {
        CommandError::capture(
            CaptureFailure::Busy,
            format!("Не удалось начать запись системного звука: {error}"),
        )
    })?;
    Ok(Opened {
        capture: Box::new(loopback),
        playing: None,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn open_system(_sink: impl SampleSink) -> CommandResult<Opened> {
    Err(CommandError::capture(
        CaptureFailure::NoDevice,
        "Запись системного звука на этой ОС не поддерживается",
    ))
}

/// An id of the default input device now, to notice that it changed;
/// `None` without one.
pub fn default_input_id() -> Option<String> {
    let device = cpal::default_host().default_input_device()?;
    device.id().ok().map(|id| id.to_string())
}

/// The default input device. `cpal::Stream` must stay on the thread that
/// built it, so the stream lives on its own thread until this is dropped.
struct Microphone {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Microphone {
    fn open(sink: impl SampleSink) -> CommandResult<Self> {
        let (ready_sender, ready) = mpsc::channel();
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = thread::Builder::new()
            .name("grill-mic".to_owned())
            .spawn(move || match build_input(sink) {
                Ok(stream) => {
                    let _ = ready_sender.send(Ok(()));
                    // Returns when `stop` is dropped.
                    let _ = stopped.recv();
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                }
            })
            .map_err(|error| CommandError::capture(CaptureFailure::Busy, error.to_string()))?;
        let opened = ready.recv().unwrap_or_else(|_| {
            Err(CommandError::capture(
                CaptureFailure::Busy,
                "Захват микрофона остановился",
            ))
        });
        let microphone = Self {
            stop: Some(stop),
            thread: Some(thread),
        };
        opened.map(|()| microphone)
    }
}

impl Drop for Microphone {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn cpal_error(error: &cpal::Error) -> CommandError {
    use cpal::ErrorKind;
    let reason = match error.kind() {
        ErrorKind::PermissionDenied => CaptureFailure::NoAccess,
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable => CaptureFailure::NoDevice,
        _ => CaptureFailure::Busy,
    };
    CommandError::capture(reason, format!("Не удалось открыть микрофон: {error}"))
}

fn build_input<S: SampleSink>(sink: S) -> CommandResult<cpal::Stream> {
    let device = cpal::default_host().default_input_device().ok_or_else(|| {
        CommandError::capture(CaptureFailure::NoDevice, "Нет ни одного микрофона")
    })?;
    let supported = device
        .default_input_config()
        .map_err(|error| cpal_error(&error))?;
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => input::<f32, S>(&device, config, sink),
        SampleFormat::F64 => input::<f64, S>(&device, config, sink),
        SampleFormat::I8 => input::<i8, S>(&device, config, sink),
        SampleFormat::I16 => input::<i16, S>(&device, config, sink),
        SampleFormat::I32 => input::<i32, S>(&device, config, sink),
        SampleFormat::U8 => input::<u8, S>(&device, config, sink),
        SampleFormat::U16 => input::<u16, S>(&device, config, sink),
        SampleFormat::U32 => input::<u32, S>(&device, config, sink),
        other => {
            return Err(CommandError::capture(
                CaptureFailure::Busy,
                format!("Формат микрофона {other:?} не поддерживается"),
            ));
        }
    }
    .map_err(|error| cpal_error(&error))?;
    stream.play().map_err(|error| cpal_error(&error))?;
    Ok(stream)
}

/// The host time of a `cpal` input block's first frame on [`super::clock`].
///
/// - macOS: `callback` is the AUHAL input `mHostTime`, the same "input
///   time" the tap's IOProc gets. `capture` would be that minus the device
///   buffer, latency and safety offset, i.e. ~a buffer earlier than the tap
///   on the same audio, so the tap and the microphone are compared on
///   `callback`.
/// - Windows: `capture` is `GetBuffer`'s QPC position, as for the loopback.
/// - Elsewhere: no shared clock; the sink stamps "now − block".
///
/// The sink also replaces a zero or implausible stamp
/// ([`super::clock::block_stamp_ns`]).
#[allow(clippy::missing_const_for_fn, unused_variables)]
fn host_time(info: &cpal::InputCallbackInfo) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        u64::try_from(info.timestamp().callback.as_nanos()).ok()
    }
    #[cfg(windows)]
    {
        u64::try_from(info.timestamp().capture.as_nanos())
            .ok()
            .filter(|nanos| *nanos > 0)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

fn input<T, S>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut sink: S,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
    S: SampleSink,
{
    let errors = sink.breakdown();
    let format = BlockFormat {
        channels: config.channels,
        sample_rate: config.sample_rate,
    };
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], info| {
            sink.push(
                format,
                host_time(info),
                data.iter().map(|sample| f32::from_sample_(*sample)),
            );
        },
        move |error| match stream_failure(error.kind()) {
            Some(reason) => errors.fail(reason, format!("Микрофон перестал работать: {error}")),
            None => eprintln!("grill: microphone stream: {error}"),
        },
        None,
    )
}

/// Which stream errors end the capture (and how the subscriber hears of
/// them); glitches and reroutes don't.
fn stream_failure(kind: cpal::ErrorKind) -> Option<CaptureFailure> {
    use cpal::ErrorKind;
    match kind {
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable => {
            Some(CaptureFailure::NoDevice)
        }
        ErrorKind::PermissionDenied => Some(CaptureFailure::NoAccess),
        ErrorKind::DeviceBusy
        | ErrorKind::StreamInvalidated
        | ErrorKind::BackendError
        | ErrorKind::ResourceExhausted
        | ErrorKind::Other => Some(CaptureFailure::Busy),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(result: CommandResult<()>) -> Option<CaptureFailure> {
        match result {
            Err(CommandError::External { reason, .. }) => reason,
            _ => None,
        }
    }

    #[test]
    fn capture_needs_the_access() {
        let status = PermissionStatus::new;
        assert!(ensure_access(&status(PermissionState::Granted), "микрофону").is_ok());
        assert!(
            ensure_access(&status(PermissionState::Unknown), "записи").is_ok(),
            "unknown tries and shows silence"
        );
        assert_eq!(
            reason(ensure_access(
                &status(PermissionState::NotDetermined),
                "микрофону"
            )),
            Some(CaptureFailure::NoAccess),
            "never prompts by itself"
        );
        let old = PermissionStatus {
            state: PermissionState::Denied,
            message: Some(permissions::OLD_MACOS.to_owned()),
        };
        let error = ensure_access(&old, "записи").unwrap_err();
        assert_eq!(
            error,
            CommandError::capture(CaptureFailure::NoAccess, permissions::OLD_MACOS)
        );
    }

    #[test]
    fn stream_errors_that_end_the_capture() {
        use cpal::ErrorKind;
        assert_eq!(
            stream_failure(ErrorKind::DeviceNotAvailable),
            Some(CaptureFailure::NoDevice)
        );
        assert_eq!(
            stream_failure(ErrorKind::PermissionDenied),
            Some(CaptureFailure::NoAccess)
        );
        assert_eq!(
            stream_failure(ErrorKind::StreamInvalidated),
            Some(CaptureFailure::Busy)
        );
        for glitch in [
            ErrorKind::Xrun,
            ErrorKind::DeviceChanged,
            ErrorKind::RealtimeDenied,
        ] {
            assert_eq!(stream_failure(glitch), None, "{glitch:?}");
        }
    }
}
