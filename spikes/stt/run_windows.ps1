# Windows reproduction of the STT spike (see docs/spikes/stt.md, section "Windows").
# Prereqs: Python 3.12/3.13 (py launcher), data\ copied from a Mac (make_dataset.py needs `say`),
# whisper.cpp release zip unpacked into .\whisper (whisper-server.exe, whisper-bench.exe, *.dll).
#
#   powershell -ExecutionPolicy Bypass -File run_windows.ps1 -Bin .\whisper\Release            # CPU build
#   powershell -ExecutionPolicy Bypass -File run_windows.ps1 -Bin .\whisper-cuda\Release -Tag cuda
#   powershell -ExecutionPolicy Bypass -File run_windows.ps1 -Bin <whisper.cpp>\build\bin\Release -Tag vulkan
#   add -Quick for the ~1-minute onboarding-style check (3 phrases per language, small + turbo-q5 only)
param(
    [string]$Bin = ".\whisper\Release",
    [string]$Tag = "cpu",
    [int]$Threads = 0,
    [switch]$Quick
)
$ErrorActionPreference = "Continue"  # whisper*.exe log to stderr; "Stop" would abort on it in PS 5.1
Set-Location $PSScriptRoot
if ($Threads -le 0) { $Threads = [Math]::Min(8, (Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum) }
$NoGpu = @(); $Ng = @()
if ($Tag -eq "cpu") { $NoGpu = @("--no-gpu"); $Ng = @("-ng") }

if (-not (Test-Path .venv)) {
    py -3 -m venv .venv
    .\.venv\Scripts\pip install psutil numpy sherpa-onnx
}
$Py = ".\.venv\Scripts\python.exe"
New-Item -ItemType Directory -Force models, runs | Out-Null

$hf = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
foreach ($m in "ggml-small.bin", "ggml-large-v3-turbo-q5_0.bin") {
    if (-not (Test-Path "models\$m")) { Invoke-WebRequest "$hf/$m" -OutFile "models\$m" }
}
if (-not (Test-Path models\ggml-silero-v5.1.2.bin)) {
    Invoke-WebRequest "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" -OutFile models\ggml-silero-v5.1.2.bin
}

# 0. machine info
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors | Format-List | Out-File "runs\$Tag-machine.txt"
Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | Format-List | Out-File -Append "runs\$Tag-machine.txt"
"RAM GB: " + [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) | Out-File -Append "runs\$Tag-machine.txt"

$Server = Join-Path $Bin "whisper-server.exe"
if ($Quick) {
    foreach ($m in "small", "large-v3-turbo-q5_0") {
        & $Py bench.py --server-bin $Server --model "models\ggml-$m.bin" --tag "$Tag-quick-$m" --threads $Threads @NoGpu --limit 3 --passes call:none
    }
    exit
}

# 1. encoder-only timings (comparable with whisper.cpp issue #89 and the Mac numbers)
foreach ($m in "small", "large-v3-turbo-q5_0") {
    & (Join-Path $Bin "whisper-bench.exe") -m "models\ggml-$m.bin" -t $Threads @Ng 2>&1 |
        Select-String "load time|encode time|decode time|total time" | Out-File -Append "runs\$Tag-whisper-bench.txt"
}
# 2. per-phrase latency + quality, real-time paced (both models, full and 768-frame encoder window)
foreach ($m in "small", "large-v3-turbo-q5_0") {
    & $Py bench.py --server-bin $Server --model "models\ggml-$m.bin" --tag "$Tag-$m" --threads $Threads @NoGpu --passes call:none call:glossary
    & $Py bench.py --server-bin $Server --model "models\ggml-$m.bin" --tag "$Tag-$m-ac768" --threads $Threads @NoGpu --audio-ctx 768 --passes call:none
}
# 3. GigaAM v3 (ru, CPU) - download from k2-fsa releases first (see docs), then:
if (Test-Path models\gigaam) {
    & $Py gigaam.py --kind rnnt --threads $Threads
    & $Py gigaam.py --kind ctc --threads $Threads
}
# 4. hallucinations with/without VAD
& $Py halluc.py --server-bin $Server @NoGpu --model models\ggml-large-v3-turbo-q5_0.bin --tag "$Tag-turbo-q5"
# 5. tables -> runs\report.md
& $Py score.py | Out-Null
Write-Host "done: runs\report.md, runs\*.meta.json (realtime_ok), runs\$Tag-whisper-bench.txt"
