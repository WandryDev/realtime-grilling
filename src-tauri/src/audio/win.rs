//! System audio on Windows (compile-checked only, like the spike), from
//! `spikes/audio/src/win/loopback.rs`.
//!
//! Process loopback (build 20348+, works on 19041+ in practice) captures
//! everything that plays except our own process tree. If it can't be
//! activated, endpoint loopback of the default output is the fallback: it
//! includes our own sound, which the onboarding doesn't play.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        Media::Audio::{
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
            AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync,
            IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            IMMDeviceEnumerator, MMDeviceEnumerator,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, eConsole, eRender,
        },
        System::{
            Com::{
                BLOB, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize, StructuredStorage::PROPVARIANT,
            },
            Threading::{CreateEventW, SetEvent, WaitForSingleObject},
            Variant::VT_BLOB,
        },
    },
    core::{HRESULT, IUnknown, Interface, implement},
};

use super::level::Feed;
use crate::error::CaptureFailure;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// How often the capture client is read.
const POLL: Duration = Duration::from_millis(10);

/// An event handle closed when the last owner drops it. The completion
/// handler owns it too, so a completion that comes after our wait timed out
/// still signals a live handle.
struct Event(isize);

impl Event {
    fn new() -> windows::core::Result<Self> {
        // SAFETY: a plain auto-reset event, closed in `Drop`.
        let handle = unsafe { CreateEventW(None, false, false, None)? };
        // `HANDLE` is neither `Send` nor `Sync`: keep its raw value.
        Ok(Self(handle.0 as isize))
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0 as _)
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle is owned here and closed once.
        let _ = unsafe { CloseHandle(self.handle()) };
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationDone {
    event: Arc<Event>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationDone_Impl {
    fn ActivateCompleted(
        &self,
        _operation: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // SAFETY: the handle lives as long as this handler (`Arc`).
        unsafe { SetEvent(self.event.handle()) }
    }
}

fn text(error: &windows::core::Error) -> String {
    error.message()
}

/// A process loopback client that excludes `pid` and its children.
fn activate_process_loopback(pid: u32) -> Result<IAudioClient, String> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let mut variant = PROPVARIANT::default();
    // SAFETY: a VT_BLOB pointing at `params`, which outlives the activation.
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: u32::try_from(size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>()).unwrap_or(0),
            pBlobData: (&raw mut params).cast(),
        };
    }
    let event = Arc::new(Event::new().map_err(|error| text(&error))?);
    // SAFETY: plain Win32/COM calls; the handler keeps the event alive.
    unsafe {
        let handler: IActivateAudioInterfaceCompletionHandler = ActivationDone {
            event: Arc::clone(&event),
        }
        .into();
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&variant),
            &handler,
        );
        let waited = operation
            .is_ok()
            .then(|| WaitForSingleObject(event.handle(), 5_000));
        let operation = operation.map_err(|error| text(&error))?;
        if waited != Some(WAIT_OBJECT_0) {
            return Err("активация process loopback не завершилась за 5 с".to_owned());
        }
        let mut result = HRESULT(0);
        let mut interface: Option<IUnknown> = None;
        operation
            .GetActivateResult(&mut result, &mut interface)
            .map_err(|error| text(&error))?;
        result.ok().map_err(|error| text(&error))?;
        interface
            .ok_or_else(|| "нет интерфейса IAudioClient".to_owned())?
            .cast()
            .map_err(|error| text(&error))
    }
}

/// Process loopback has no mix format: we pick PCM16 48 kHz stereo.
fn pcm16_stereo_48k() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM,
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 4,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

#[derive(Clone, Copy)]
enum SampleKind {
    I16,
    F32,
}

fn kind_of(format: &WAVEFORMATEX) -> Result<SampleKind, String> {
    let tag = format.wFormatTag;
    let bits = format.wBitsPerSample;
    match (tag, bits) {
        (WAVE_FORMAT_PCM | WAVE_FORMAT_EXTENSIBLE, 16) => Ok(SampleKind::I16),
        (WAVE_FORMAT_IEEE_FLOAT | WAVE_FORMAT_EXTENSIBLE, 32) => Ok(SampleKind::F32),
        _ => Err(format!("формат {tag:#x}, {bits} бит не поддерживается")),
    }
}

fn process_loopback() -> Result<(IAudioClient, WAVEFORMATEX), String> {
    let client = activate_process_loopback(std::process::id())?;
    let format = pcm16_stereo_48k();
    // SAFETY: `format` outlives the call.
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            200_000,
            0,
            &format,
            None,
        )
    }
    .map_err(|error| text(&error))?;
    Ok((client, format))
}

fn endpoint_loopback() -> Result<(IAudioClient, WAVEFORMATEX), String> {
    // SAFETY: COM is initialized on this thread; the mix format is freed
    // after `Initialize` copied it.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| text(&error))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|error| text(&error))?;
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| text(&error))?;
        let mix = client.GetMixFormat().map_err(|error| text(&error))?;
        let format = *mix;
        let initialized = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            1_000_000,
            0,
            mix,
            None,
        );
        CoTaskMemFree(Some(mix.cast()));
        initialized.map_err(|error| text(&error))?;
        Ok((client, format))
    }
}

/// Reads the captured packets into the meter.
fn drain(
    capture: &IAudioCaptureClient,
    kind: SampleKind,
    channels: usize,
    feed: &Feed,
) -> windows::core::Result<()> {
    // SAFETY: each buffer is read before it is released.
    unsafe {
        loop {
            if capture.GetNextPacketSize()? == 0 {
                return Ok(());
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let count = frames as usize * channels;
            #[allow(clippy::cast_sign_loss)]
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
            if silent || data.is_null() {
                feed.push(std::iter::repeat_n(0.0, count));
            } else {
                match kind {
                    SampleKind::I16 => {
                        let samples = std::slice::from_raw_parts(data.cast::<i16>(), count);
                        feed.push(samples.iter().map(|sample| f32::from(*sample) / 32_768.0));
                    }
                    SampleKind::F32 => {
                        let samples = std::slice::from_raw_parts(data.cast::<f32>(), count);
                        feed.push(samples.iter().copied());
                    }
                }
            }
            capture.ReleaseBuffer(frames)?;
        }
    }
}

fn run(
    feed: &Feed,
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let (client, format) = process_loopback().or_else(|error| {
        eprintln!("grill: process loopback unavailable ({error}), using endpoint loopback");
        endpoint_loopback()
    })?;
    let kind = kind_of(&format)?;
    let channels = usize::from(format.nChannels);
    // SAFETY: the client is initialized.
    let capture: IAudioCaptureClient =
        unsafe { client.GetService() }.map_err(|error| text(&error))?;
    // SAFETY: as above.
    unsafe { client.Start() }.map_err(|error| text(&error))?;
    let _ = ready.send(Ok(()));
    let mut result = Ok(());
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(POLL);
        if let Err(error) = drain(&capture, kind, channels, feed) {
            // Reaches the subscribers as `AudioLevelStopped`, not as zeros.
            feed.fail(
                CaptureFailure::Busy,
                format!("Запись системного звука прервалась: {}", text(&error)),
            );
            result = Err(text(&error));
            break;
        }
    }
    // SAFETY: as above.
    let _ = unsafe { client.Stop() };
    result
}

/// A running loopback capture; dropping it stops the thread within ~10 ms.
pub struct Loopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Loopback {
    pub fn start(feed: Feed) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_sender, ready) = mpsc::channel();
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("grill-loopback".to_owned())
            .spawn(move || {
                // SAFETY: COM for this thread only, released below.
                let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                if let Err(error) = run(&feed, &thread_stop, &ready_sender) {
                    eprintln!("grill: system audio loopback stopped: {error}");
                    let _ = ready_sender.send(Err(error));
                }
                if com.is_ok() {
                    // SAFETY: balances the successful `CoInitializeEx`.
                    unsafe { CoUninitialize() };
                }
            })
            .map_err(|error| error.to_string())?;
        let started = ready
            .recv()
            .unwrap_or_else(|_| Err("захват системного звука остановился".to_owned()));
        let loopback = Self {
            stop,
            thread: Some(thread),
        };
        started.map(|()| loopback)
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
