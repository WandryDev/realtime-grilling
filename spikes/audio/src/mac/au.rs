//! AudioUnit capture/playback: raw mic (AUHAL), VoiceProcessingIO (VPIO) mic, and AUHAL playback.
//! Callbacks push into a Mutex<Vec> - not real-time safe, fine for a spike.
#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::c_void;
use std::ptr;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use objc2_core_audio::AudioObjectID;
use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};

use super::hal::{self, check, fourcc};

#[repr(C)]
struct AudioComponentDescription {
    componentType: u32,
    componentSubType: u32,
    componentManufacturer: u32,
    componentFlags: u32,
    componentFlagsMask: u32,
}
type AudioComponent = *mut c_void;
type AudioUnit = *mut c_void;
type AURenderCallback =
    unsafe extern "C" fn(*mut c_void, *mut u32, *const AudioTimeStamp, u32, u32, *mut AudioBufferList) -> i32;
#[repr(C)]
struct AURenderCallbackStruct {
    inputProc: AURenderCallback,
    inputProcRefCon: *mut c_void,
}
/// AudioUnitProperties.h: struct { Boolean mEnableAdvancedDucking; UInt32 mDuckingLevel; }
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct DuckingConfig {
    pub enable_advanced: u8,
    pub level: u32,
}

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioComponentFindNext(c: AudioComponent, d: *const AudioComponentDescription) -> AudioComponent;
    fn AudioComponentInstanceNew(c: AudioComponent, out: *mut AudioUnit) -> i32;
    fn AudioComponentInstanceDispose(u: AudioUnit) -> i32;
    fn AudioUnitSetProperty(u: AudioUnit, id: u32, scope: u32, el: u32, data: *const c_void, size: u32) -> i32;
    fn AudioUnitGetProperty(u: AudioUnit, id: u32, scope: u32, el: u32, data: *mut c_void, size: *mut u32) -> i32;
    fn AudioUnitInitialize(u: AudioUnit) -> i32;
    fn AudioUnitUninitialize(u: AudioUnit) -> i32;
    fn AudioOutputUnitStart(u: AudioUnit) -> i32;
    fn AudioOutputUnitStop(u: AudioUnit) -> i32;
    fn AudioUnitRender(
        u: AudioUnit,
        flags: *mut u32,
        ts: *const AudioTimeStamp,
        bus: u32,
        frames: u32,
        data: *mut AudioBufferList,
    ) -> i32;
}

// AUComponent.h / AudioUnitProperties.h (macOS 26 SDK)
const kAudioUnitType_Output: u32 = fourcc(b"auou");
const kAudioUnitSubType_HALOutput: u32 = fourcc(b"ahal");
const kAudioUnitSubType_VoiceProcessingIO: u32 = fourcc(b"vpio");
const kAudioUnitManufacturer_Apple: u32 = fourcc(b"appl");
const SCOPE_GLOBAL: u32 = 0;
const SCOPE_INPUT: u32 = 1;
const SCOPE_OUTPUT: u32 = 2;
const kAudioUnitProperty_StreamFormat: u32 = 8;
const kAudioUnitProperty_SetRenderCallback: u32 = 23;
const kAudioOutputUnitProperty_CurrentDevice: u32 = 2000;
const kAudioOutputUnitProperty_EnableIO: u32 = 2003;
const kAudioOutputUnitProperty_SetInputCallback: u32 = 2005;
const kAUVoiceIOProperty_BypassVoiceProcessing: u32 = 2100;
const kAUVoiceIOProperty_VoiceProcessingEnableAGC: u32 = 2101;
const kAUVoiceIOProperty_OtherAudioDuckingConfiguration: u32 = 2108;
const kAudioFormatLinearPCM: u32 = fourcc(b"lpcm");
const kAudioFormatFlagIsFloat: u32 = 1;
const kAudioFormatFlagIsPacked: u32 = 8;

const MAX_FRAMES: usize = 8192;

fn asbd(rate: f64, channels: u32) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4 * channels,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4 * channels,
        mChannelsPerFrame: channels,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

unsafe fn set_prop<T>(u: AudioUnit, id: u32, scope: u32, el: u32, v: &T, what: &str) -> Result<()> {
    let st = unsafe { AudioUnitSetProperty(u, id, scope, el, ptr::from_ref(v).cast(), size_of::<T>() as u32) };
    check(st, what)
}

fn new_unit(sub: u32) -> Result<AudioUnit> {
    let desc = AudioComponentDescription {
        componentType: kAudioUnitType_Output,
        componentSubType: sub,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0,
    };
    let comp = unsafe { AudioComponentFindNext(ptr::null_mut(), &desc) };
    if comp.is_null() {
        bail!("AudioComponent '{}' not found", hal::cc_str(sub));
    }
    let mut u: AudioUnit = ptr::null_mut();
    check(unsafe { AudioComponentInstanceNew(comp, &mut u) }, "AudioComponentInstanceNew")?;
    Ok(u)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Raw,
    Vpio,
    VpioBypass,
    /// VPIO with the output element disabled (EnableIO output = 0).
    VpioInputOnly,
}

struct Shared {
    unit: AudioUnit,
    buf: Vec<f32>,
    out: Mutex<Vec<f32>>,
    /// Signal rendered through the VPIO's own output bus (far-end played by *us*), mono.
    play: Vec<f32>,
    play_pos: std::sync::atomic::AtomicUsize,
    render_err: std::sync::atomic::AtomicI32,
}

pub struct Capture {
    unit: AudioUnit,
    shared: Arc<Shared>,
    pub rate: f64,
    stopped: bool,
}

unsafe impl Send for Capture {}

unsafe extern "C" fn input_cb(
    refcon: *mut c_void,
    flags: *mut u32,
    ts: *const AudioTimeStamp,
    _bus: u32,
    frames: u32,
    _data: *mut AudioBufferList,
) -> i32 {
    let sh = unsafe { &*(refcon as *const Shared) };
    let frames = (frames as usize).min(MAX_FRAMES);
    let buf_ptr = sh.buf.as_ptr().cast_mut();
    let mut abl = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer { mNumberChannels: 1, mDataByteSize: (frames * 4) as u32, mData: buf_ptr.cast() }],
    };
    let st = unsafe { AudioUnitRender(sh.unit, flags, ts, 1, frames as u32, &mut abl) };
    if st != 0 {
        sh.render_err.store(st, std::sync::atomic::Ordering::Relaxed);
        return st;
    }
    let s = unsafe { std::slice::from_raw_parts(buf_ptr, frames) };
    sh.out.lock().unwrap().extend_from_slice(s);
    0
}

unsafe extern "C" fn vpio_render_cb(
    refcon: *mut c_void,
    _flags: *mut u32,
    _ts: *const AudioTimeStamp,
    _bus: u32,
    frames: u32,
    data: *mut AudioBufferList,
) -> i32 {
    let sh = unsafe { &*(refcon as *const Shared) };
    let abl = unsafe { &mut *data };
    let pos = sh.play_pos.fetch_add(frames as usize, std::sync::atomic::Ordering::Relaxed);
    let bufs = unsafe { std::slice::from_raw_parts_mut(abl.mBuffers.as_mut_ptr(), abl.mNumberBuffers as usize) };
    for b in bufs {
        let ch = b.mNumberChannels.max(1) as usize;
        let n = b.mDataByteSize as usize / 4;
        let out = unsafe { std::slice::from_raw_parts_mut(b.mData.cast::<f32>(), n) };
        for (i, frame) in out.chunks_mut(ch).enumerate() {
            let v = sh.play.get(pos + i).copied().unwrap_or(0.0);
            frame.fill(v);
        }
    }
    0
}

impl Capture {
    /// `input`/`output` = None means the system default device.
    pub fn start(mode: Mode, input: Option<AudioObjectID>, output: Option<AudioObjectID>) -> Result<Self> {
        Self::start_ex(mode, input, output, Vec::new(), None)
    }

    pub fn start_ex(
        mode: Mode,
        input: Option<AudioObjectID>,
        output: Option<AudioObjectID>,
        play: Vec<f32>,
        ducking: Option<DuckingConfig>,
    ) -> Result<Self> {
        let in_dev = match input {
            Some(d) => d,
            None => hal::default_input()?,
        };
        let vpio = mode != Mode::Raw;
        let unit = new_unit(if vpio { kAudioUnitSubType_VoiceProcessingIO } else { kAudioUnitSubType_HALOutput })?;
        // AUHAL input does not resample: use the device rate. VPIO resamples internally.
        let rate = if vpio { 48_000.0 } else { hal::get::<f64>(in_dev, hal::DEV_NOMINAL_RATE, hal::SCOPE_GLOBAL)? };
        let one: u32 = 1;
        let zero: u32 = 0;
        unsafe {
            set_prop(unit, kAudioOutputUnitProperty_EnableIO, SCOPE_INPUT, 1, &one, "EnableIO input")?;
            if vpio {
                let out_on = if mode == Mode::VpioInputOnly { &zero } else { &one };
                set_prop(unit, kAudioOutputUnitProperty_EnableIO, SCOPE_OUTPUT, 0, out_on, "EnableIO output")?;
                if let Err(e) = set_prop(unit, kAudioOutputUnitProperty_CurrentDevice, SCOPE_GLOBAL, 1, &in_dev, "VPIO CurrentDevice(input el.1)") {
                    eprintln!("warn: {e}");
                }
                let out_dev = match output {
                    Some(d) => d,
                    None => hal::default_output()?,
                };
                if let Err(e) = set_prop(unit, kAudioOutputUnitProperty_CurrentDevice, SCOPE_GLOBAL, 0, &out_dev, "VPIO CurrentDevice(output el.0)") {
                    eprintln!("warn: {e}");
                }
                // AGC off so that level comparisons with raw input are meaningful.
                set_prop(unit, kAUVoiceIOProperty_VoiceProcessingEnableAGC, SCOPE_GLOBAL, 0, &zero, "VPIO AGC off")?;
                if mode == Mode::VpioBypass {
                    set_prop(unit, kAUVoiceIOProperty_BypassVoiceProcessing, SCOPE_GLOBAL, 0, &one, "VPIO bypass")?;
                }
                if let Some(cfg) = ducking.filter(|_| std::env::var_os("SPIKE_DUCK_AFTER_START").is_none()) {
                    set_prop(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, SCOPE_GLOBAL, 0, &cfg, "VPIO ducking config")?;
                }
            } else {
                set_prop(unit, kAudioOutputUnitProperty_EnableIO, SCOPE_OUTPUT, 0, &zero, "EnableIO output=0")?;
                set_prop(unit, kAudioOutputUnitProperty_CurrentDevice, SCOPE_GLOBAL, 0, &in_dev, "CurrentDevice")?;
            }
            let fmt = asbd(rate, 1);
            set_prop(unit, kAudioUnitProperty_StreamFormat, SCOPE_OUTPUT, 1, &fmt, "StreamFormat in-bus")?;
            if vpio && mode != Mode::VpioInputOnly {
                set_prop(unit, kAudioUnitProperty_StreamFormat, SCOPE_INPUT, 0, &fmt, "StreamFormat out-bus")?;
            }
        }
        let shared = Arc::new(Shared {
            unit,
            buf: vec![0.0; MAX_FRAMES],
            out: Mutex::new(Vec::with_capacity(rate as usize * 60)),
            play,
            play_pos: 0.into(),
            render_err: 0.into(),
        });
        let refcon = Arc::as_ptr(&shared).cast_mut().cast::<c_void>();
        unsafe {
            let cb = AURenderCallbackStruct { inputProc: input_cb, inputProcRefCon: refcon };
            set_prop(unit, kAudioOutputUnitProperty_SetInputCallback, SCOPE_GLOBAL, 0, &cb, "SetInputCallback")?;
            if vpio && mode != Mode::VpioInputOnly {
                let rcb = AURenderCallbackStruct { inputProc: vpio_render_cb, inputProcRefCon: refcon };
                set_prop(unit, kAudioUnitProperty_SetRenderCallback, SCOPE_INPUT, 0, &rcb, "SetRenderCallback")?;
            }
            check(AudioUnitInitialize(unit), "AudioUnitInitialize")?;
            check(AudioOutputUnitStart(unit), "AudioOutputUnitStart")?;
            if vpio
                && let Some(cfg) = ducking.filter(|_| std::env::var_os("SPIKE_DUCK_AFTER_START").is_some())
            {
                set_prop(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, SCOPE_GLOBAL, 0, &cfg, "VPIO ducking config (after start)")?;
            }
        }
        if vpio {
            let mut cfg = DuckingConfig::default();
            let mut sz = size_of::<DuckingConfig>() as u32;
            let st = unsafe {
                AudioUnitGetProperty(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, SCOPE_GLOBAL, 0, ptr::from_mut(&mut cfg).cast(), &mut sz)
            };
            eprintln!("VPIO OtherAudioDuckingConfiguration (read back): status={st} {cfg:?}");
        }
        Ok(Self { unit, shared, rate, stopped: false })
    }

    pub fn render_error(&self) -> i32 {
        self.shared.render_err.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn take(&self) -> Vec<f32> {
        std::mem::take(&mut *self.shared.out.lock().unwrap())
    }

    pub fn stop(mut self) -> Vec<f32> {
        self.shutdown();
        self.take()
    }

    fn shutdown(&mut self) {
        if !self.stopped {
            unsafe {
                AudioOutputUnitStop(self.unit);
                AudioUnitUninitialize(self.unit);
                AudioComponentInstanceDispose(self.unit);
            }
            self.stopped = true;
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------------------------
// Playback through AUHAL to a chosen device (used as "the other app" playing far-end audio).

struct PlayShared {
    samples: Vec<f32>,
    pos: std::sync::atomic::AtomicUsize,
}

unsafe extern "C" fn play_cb(
    refcon: *mut c_void,
    _flags: *mut u32,
    _ts: *const AudioTimeStamp,
    _bus: u32,
    frames: u32,
    data: *mut AudioBufferList,
) -> i32 {
    let sh = unsafe { &*(refcon as *const PlayShared) };
    let pos = sh.pos.fetch_add(frames as usize, std::sync::atomic::Ordering::Relaxed);
    let abl = unsafe { &mut *data };
    let b = &mut abl.mBuffers[0];
    let out = unsafe { std::slice::from_raw_parts_mut(b.mData.cast::<f32>(), b.mDataByteSize as usize / 4) };
    for (i, fr) in out.chunks_mut(2).enumerate() {
        fr.fill(sh.samples.get(pos + i).copied().unwrap_or(0.0));
    }
    0
}

/// Plays mono `samples` (at `rate`) on `device` (None = default output), blocking until done.
pub fn play_blocking(samples: Vec<f32>, rate: f64, device: Option<AudioObjectID>) -> Result<()> {
    let unit = new_unit(kAudioUnitSubType_HALOutput)?;
    let dur = samples.len() as f64 / rate;
    let sh = Arc::new(PlayShared { samples, pos: 0.into() });
    unsafe {
        if let Some(d) = device {
            set_prop(unit, kAudioOutputUnitProperty_CurrentDevice, SCOPE_GLOBAL, 0, &d, "CurrentDevice(out)")?;
        }
        let fmt = asbd(rate, 2);
        set_prop(unit, kAudioUnitProperty_StreamFormat, SCOPE_INPUT, 0, &fmt, "StreamFormat(out)")?;
        let cb = AURenderCallbackStruct { inputProc: play_cb, inputProcRefCon: Arc::as_ptr(&sh).cast_mut().cast() };
        set_prop(unit, kAudioUnitProperty_SetRenderCallback, SCOPE_INPUT, 0, &cb, "SetRenderCallback")?;
        check(AudioUnitInitialize(unit), "AudioUnitInitialize(out)")?;
        check(AudioOutputUnitStart(unit), "AudioOutputUnitStart(out)")?;
    }
    std::thread::sleep(std::time::Duration::from_secs_f64(dur + 0.3));
    unsafe {
        AudioOutputUnitStop(unit);
        AudioUnitUninitialize(unit);
        AudioComponentInstanceDispose(unit);
    }
    Ok(())
}
