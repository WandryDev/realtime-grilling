//! Item 3a (Windows, compile-checked only): system audio capture.
//!
//! Preferred: process loopback (Windows 10 2004 / build 19041+):
//!   ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IAudioClient,
//!     AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { our PID, EXCLUDE_TARGET_PROCESS_TREE } })
//!   => everything that plays, except our own process tree.
//! Fallback (`--legacy`, or if the above fails): AUDCLNT_STREAMFLAGS_LOOPBACK on the default
//! render endpoint (includes our own output; no packets while nothing plays).

use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, eConsole, eRender,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{BLOB, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{HRESULT, IUnknown, Interface, implement};

use crate::{Args, dsp};

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationDone {
    event: isize, // HANDLE is not Send/Sync; keep the raw value
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationDone_Impl {
    fn ActivateCompleted(&self, _op: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        unsafe { SetEvent(HANDLE(self.event as _)) }
    }
}

/// Activates an IAudioClient for process loopback that excludes `pid` and its child processes.
fn activate_process_loopback(pid: u32) -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let mut pv = PROPVARIANT::default();
    unsafe {
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: (&raw mut params).cast(),
        };
    }
    let event = unsafe { CreateEventW(None, false, false, None)? };
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationDone { event: event.0 as isize }.into();
    let op = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&pv), &handler)? };
    let waited = unsafe { WaitForSingleObject(event, 5_000) };
    unsafe { CloseHandle(event).ok() };
    if waited != WAIT_OBJECT_0 {
        return Err(anyhow!("ActivateAudioInterfaceAsync: completion not signalled within 5 s"));
    }
    let mut hr = HRESULT(0);
    let mut unk: Option<IUnknown> = None;
    unsafe { op.GetActivateResult(&mut hr, &mut unk)? };
    hr.ok().context("process loopback activation result")?;
    Ok(unk.context("no interface")?.cast()?)
}

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

fn kind_of(fmt: &WAVEFORMATEX) -> Result<SampleKind> {
    let tag = fmt.wFormatTag;
    let bits = fmt.wBitsPerSample;
    match (tag, bits) {
        (WAVE_FORMAT_PCM, 16) => Ok(SampleKind::I16),
        (WAVE_FORMAT_IEEE_FLOAT, 32) => Ok(SampleKind::F32),
        // Shared-mode mix formats are WAVEFORMATEXTENSIBLE float32 in practice.
        (WAVE_FORMAT_EXTENSIBLE, 32) => Ok(SampleKind::F32),
        (WAVE_FORMAT_EXTENSIBLE, 16) => Ok(SampleKind::I16),
        _ => Err(anyhow!("unsupported format tag={tag:#x} bits={bits}")),
    }
}

pub fn run(a: &Args) -> Result<()> {
    let secs = a.f64("--secs", 5.0)?;
    let out = a.str("--out", "runs/loopback.wav");
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };

    let own_pid = std::process::id();
    let process_mode = if a.flag("--legacy") {
        None
    } else {
        match activate_process_loopback(own_pid) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("process loopback unavailable ({e:#}); falling back to endpoint loopback");
                None
            }
        }
    };

    let (client, fmt, mix_ptr, label) = match process_mode {
        Some(client) => {
            // Process-loopback clients do not support GetMixFormat: we pick the format.
            let fmt = pcm16_stereo_48k();
            unsafe {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    200_000, // 20 ms in 100-ns units
                    0,
                    &fmt,
                    None,
                )?
            };
            (client, fmt, None, format!("process loopback excluding pid {own_pid} tree"))
        }
        None => {
            let en: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
            let dev = unsafe { en.GetDefaultAudioEndpoint(eRender, eConsole)? };
            let client: IAudioClient = unsafe { dev.Activate(CLSCTX_ALL, None)? };
            let mix = unsafe { client.GetMixFormat()? };
            let fmt = unsafe { *mix };
            if fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
                let ext = unsafe { &*(mix as *const WAVEFORMATEXTENSIBLE) };
                let sub = ext.SubFormat;
                eprintln!("mix format: extensible, subformat {sub:?}");
            }
            unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, mix, None)? };
            (client, fmt, Some(mix), "endpoint loopback (default render, includes our own output)".to_string())
        }
    };
    let kind = kind_of(&fmt)?;
    let channels = fmt.nChannels as usize;
    let rate = fmt.nSamplesPerSec as f64;
    let bits = fmt.wBitsPerSample;
    eprintln!("{label}: {rate} Hz, {channels} ch, {bits} bits");

    let capture: IAudioCaptureClient = unsafe { client.GetService()? };
    let mut samples: Vec<f32> = Vec::new();
    let (mut packets, mut silent_packets, mut discontinuities) = (0u64, 0u64, 0u64);
    let mut first_packet: Option<Duration> = None;
    let t0 = Instant::now();
    unsafe { client.Start()? };
    // Optional child process: it is part of OUR process tree, so process loopback must NOT hear it,
    // while endpoint loopback (--legacy) will. Run the same command from another console to compare.
    let mut child = match a.get("--spawn") {
        Some(cmd) => Some(std::process::Command::new("cmd").args(["/C", cmd]).spawn()?),
        None => None,
    };
    while t0.elapsed().as_secs_f64() < secs {
        std::thread::sleep(Duration::from_millis(10));
        loop {
            let n = unsafe { capture.GetNextPacketSize()? };
            if n == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
            first_packet.get_or_insert(t0.elapsed());
            packets += 1;
            let count = frames as usize * channels;
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                silent_packets += 1;
                samples.extend(std::iter::repeat_n(0.0, count));
            } else {
                match kind {
                    SampleKind::I16 => {
                        let s = unsafe { std::slice::from_raw_parts(data.cast::<i16>(), count) };
                        samples.extend(s.iter().map(|v| *v as f32 / 32768.0));
                    }
                    SampleKind::F32 => {
                        let s = unsafe { std::slice::from_raw_parts(data.cast::<f32>(), count) };
                        samples.extend_from_slice(s);
                    }
                }
            }
            // AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY = 1
            if flags & 1 != 0 {
                discontinuities += 1;
            }
            unsafe { capture.ReleaseBuffer(frames)? };
        }
    }
    unsafe { client.Stop()? };
    if let Some(c) = child.as_mut() {
        c.kill().ok();
        c.wait().ok();
    }
    if let Some(p) = mix_ptr {
        unsafe { CoTaskMemFree(Some(p.cast())) };
    }

    let mono = dsp::to_mono(&samples, channels);
    println!(
        "{label}: {packets} packets ({silent_packets} silent, {discontinuities} discontinuities), first after {:?}; \
         captured {:.2} s of {secs} s wall-clock; rms {:.1} dBFS, peak {:.3}",
        first_packet,
        mono.len() as f64 / rate,
        dsp::dbfs(dsp::rms(&mono)),
        dsp::peak(&mono)
    );
    dsp::write_wav(&out, &dsp::resample(&mono, rate, 16_000.0), 16_000)?;
    println!("wrote {out} (16 kHz mono)");
    Ok(())
}
