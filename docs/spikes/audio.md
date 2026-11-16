# Спайк: звук (детект микрофона, системный звук, эхоподавление)

Код: `spikes/audio` — отдельный Cargo-крейт (не входит в `src-tauri`), один бинарь `audio-spike` с подкомандами.
Машина: MacBook Air M3, 16 ГБ, macOS 26.6.2, Rust 1.99. Windows-машины не было.

Метки: **[M3]** — проверено на этой машине; **[док]** — по документации / SDK-заголовкам, не проверено; **[Win: компилируется]** — `cargo check --target x86_64-pc-windows-msvc` проходит, не запускалось.

## Сводка

| # | Вопрос | Итог | Решение |
|---|--------|------|---------|
| 1 | «Микрофон занят кем-то кроме нас» (macOS) | Работает на слушателях, задержка в пределах нескольких мс, свой PID исключается | **идём** |
| 2 | Системный звук на macOS (process tap) | Работает, свой процесс исключается, CLI получил не тишину | **идём** |
| 3 | Windows: loopback + детект микрофона | Код компилируется, не запускался | **нужна проверка на Windows** |
| 4 | Эхоподавление без наушников | VPIO приглушает чужой звук на −30 дБ (и звонок, и опорный сигнал тапа). AEC3 (`sonora`, чистый Rust) в симуляции даёт 15–28 дБ | **меняем подход**: AEC3 + тап как опорный сигнал; VPIO не берём |

Блокер для реальных замеров эха (перепроверено в конце сессии — микрофон всё ещё отдаёт нули; включённые динамики без доступа к микрофону не помогают): у ответственного за процесс приложения (T3 Code, родитель CLI) **нет доступа к микрофону**, поэтому AUHAL/VPIO отдают цифровую тишину. Команды для ручной проверки — в конце.

---

## 1. Детект «микрофон занят другим приложением» (macOS 14+)

**Что сделано** — `audio-spike mic-watch` (`src/mac/mic_watch.rs`):
- слушатель на системном объекте `kAudioHardwarePropertyProcessObjectList` (`'prs#'`): процесс появился или исчез;
- на каждом process object: слушатели `kAudioProcessPropertyIsRunningInput` (`'piri'`) **и** `kAudioProcessPropertyDevices` (`'pdv#'`, input scope); в колбэке перечитываем `piri`, `kAudioProcessPropertyPID`, `kAudioProcessPropertyBundleID`;
- `OTHERS_USING_MIC = any(piri == 1 && pid != own_pid)`;
- для сравнения — слушатель `kAudioDevicePropertyDeviceIsRunningSomewhere` (`'gone'`) на входном устройстве и опциональный поллер (`--poll-ms`);
- `kAudioHardwarePropertyRunLoop = NULL`, чтобы уведомления шли в поток HAL (у CLI нет main run loop).

Имена и FourCC сверены с `CoreAudio.framework/Headers/AudioHardware.h` из SDK macOS 26.

**Как проверяли [M3].** «Чужое приложение» — дочерний процесс, который захватывает встроенный микрофон (`audio-spike mic-record`, AUHAL). Сценарии: нормальное завершение, `SIGKILL` посреди захвата, захват нашим собственным процессом.

**Результаты [M3]:**
- **На macOS 26.6 не приходит уведомление на `'piri'`.** Слушатель только на `piri` не сработал ни разу, хотя поллер видел смену значения. Включив wildcard-слушатель, увидели, что изменение приходит как `'pdv#'/inpt` (плюс `'powh'`). Поэтому слушаем `pdv#` и в колбэке перечитываем `piri`. С таким набором уведомления приходят стабильно.
- Задержка: в 6 из 6 прогонов слушатель срабатывал **раньше** поллера с периодом 1–5 мс. На старте опережение 0.4–48 мс, на остановке 1.7–5.3 мс. Реальная задержка уведомления — единицы миллисекунд.
- Уровень процесса срабатывает на 4–8 мс раньше `DeviceIsRunningSomewhere`.
- Старт: `OTHERS_USING_MIC=true` через 107–407 мс после `spawn` дочернего процесса. Это время запуска самого дочернего процесса, а не детектора.
- Нормальная остановка: `false` за 30–200 мс до выхода процесса, то есть сразу, как он остановил IO.
- `SIGKILL`: процесс пропадает из `ProcessObjectList`, и детект приходит через ~1.5 мс после того, как наш цикл увидел выход.
- Свой захват: `piri=1` у нашего PID игнорируется, `OTHERS_USING_MIC` остаётся `false`. `DeviceIsRunningSomewhere` при этом становится `true`: «нас» от «других» он не отличает, как и ожидалось.
- `BundleID` есть у бандлов: `com.google.Chrome.helper`, `com.hnc.Discord`, `ru.keepcoder.Telegram`, `com.apple.WebKit.GPU`. У CLI-процессов он пустой, имя берём через `proc_name(pid)`. Браузерные звонилки держат микрофон в **helper-процессе**, а не в главном.
- `piri=1` выставляется, даже если у процесса **нет** разрешения TCC и он получает тишину. Для HAL такой процесс «занимает микрофон».
- ffmpeg из задания (`ffmpeg -f avfoundation -i ":1"`): первый запуск дал 5 с IO и детектировался, хотя старт занял ~4 с. Следующие запуски без разрешения на микрофон зависали на `Failed to create AV capture input device: Cannot use …` и не реагировали на SIGTERM, пришлось убить `kill -9`. Поэтому в тестах «чужим» выступает наш `mic-record`.

**Mute в звонилке ≠ конец звонка [док + рассуждение, не проверено]:**
- Zoom, Teams, Meet и Slack показывают «вы говорите с выключенным микрофоном». Для этого им нужен живой входной поток, значит при mute `IsRunningInput` остаётся 1.
- Приложения на `AVAudioApplication.setInputMuted` (macOS 14+) по замыслу Apple тоже держат IO, а данные глушит система.
- Свойство `kAudioHardwarePropertyProcessInputMute` относится только к вызывающему процессу. Чужой mute через него не прочитать.
- В браузере `track.enabled = false` устройство не отпускает, `track.stop()` — отпускает. Что делает конкретная веб-звонилка, надо проверить руками.
- **Рекомендация:** «звонок закончился» = у процесса звонилки (или её helper) **одновременно** `IsRunningInput=0` и `IsRunningOutput=0`, с дебаунсом 5–10 с. Плюс ручная кнопка «стоп».

**Ограничения:**
- Свой PID нужно исключать для **всех** наших процессов, которые пишут звук (sidecar/helper), либо по префиксу bundle ID.
- Process objects и `piri` по документации доступны с macOS 14.0.
- Как дешёвую страховку стоит оставить поллинг раз в 1–2 с.

**Решение: идём.** Основной механизм — слушатели (`prs#` + `pdv#`/`piri`), исключение по PID, конец звонка — по input+output с дебаунсом.

---

## 2. Захват системного звука на macOS (Core Audio process tap, 14.2+)

**Что сделано** — `audio-spike tap-record` (`src/mac/tap.rs`):
1. `CATapDescription initStereoGlobalTapButExcludeProcesses:@[наш process object]`, `privateTap=YES`, `muteBehavior=CATapUnmuted`;
2. `AudioHardwareCreateProcessTap`, затем `kAudioTapPropertyUID` и `kAudioTapPropertyFormat` (48 кГц, 2 канала, float32);
3. приватный aggregate device (`private=1`, `tapautostart=1`, `taps=[{uid, drift=1}]`, main sub-device — выход по умолчанию или указанный, либо без sub-device);
4. `AudioDeviceCreateIOProcID` и `AudioDeviceStart`. Звук тапа приходит как *input* агрегата; дальше даунмикс, ресемплинг в 16 кГц моно и WAV.

**Результаты [M3]:**
- Не тишина: `say …` из другого процесса пишется с уровнем −18…−21 dBFS, пик 0.73–0.78.
- **Исключение своего процесса работает.** Наш процесс играет тон 1 кГц, параллельно говорит `say`. С исключением доля энергии на 1 кГц — **0.0007**, без исключения (`--include-self`) — **0.75**. Наш process object должен существовать **до** создания тапа, то есть мы уже должны быть аудиоклиентом.
- Создание тапа и агрегата — 5–72 мс.
- **IO не стартует, пока кто-то не начнёт играть.** 3 с тишины — 0 колбэков во всех трёх вариантах агрегата (без sub-device, встроенные динамики, BT-наушники). Первый колбэк приходит, когда звук появляется: через ~0.9 с после запуска `say`, а при BT-выходе — через 2.25 с.
- **После старта поток непрерывный:** 18 с тишины между фразами — 0 разрывов `mSampleTime`, максимальный интервал между колбэками 11 мс.
- Значит, начало канала «Остальные» сдвинуто относительно микрофона. Каналы выравниваем по `mHostTime` первого колбэка, а не по числу сэмплов.
- Старт VPIO на том же выходном устройстве перезапускает таймлайн агрегата: `mSampleTime` уходит назад, разрыв ~0.3 с. С BT-гарнитурой (переключение A2DP→HFP) потеряли ~5 с. Подробнее в п. 4.

**TCC:**
- Сервис «System Audio Recording» (в настройках: «Запись экрана и системного аудио» → «Только запись системного аудио»). Ключ в Info.plist — `NSAudioCaptureUsageDescription` **[док]**.
- **Непакованный CLI [M3]:** разрешение спрашивается и учитывается от имени *ответственного* процесса, здесь это T3 Code (Beta).app, родитель CLI. Тап отдал не тишину и промпта мы не видели: у ответственного приложения доступ уже был. Проверить TCC.db нельзя (authorization denied).
- **Tauri-бандл [док]:**
  - промпт и запись в TCC привязаны к bundle ID и подписи приложения;
  - нужны `NSAudioCaptureUsageDescription` и `NSMicrophoneUsageDescription` в Info.plist (через `bundle.macOS` / свой Info.plist в `src-tauri`), а для hardened runtime — entitlement `com.apple.security.device.audio-input` (для микрофона);
  - в `tauri dev` бинарь запускается без бандла, и права достаются терминалу или IDE;
  - ad-hoc подпись меняется с каждой сборкой, и TCC начинает спрашивать заново. Для разработки нужна стабильная подпись.
- **Публичного preflight API для audio capture нет [док]:** без разрешения тап создаётся, но отдаёт тишину. Детект: у звонилки `IsRunningOutput=1`, а тап N секунд даёт нули — показываем подсказку «дайте доступ». Есть приватный SPI `TCCAccessPreflight` (так делает AudioCap) — хрупкий вариант.

**Альтернатива — ScreenCaptureKit [док]:**
- Как работает: `SCStream` с `capturesAudio=true` и `excludesCurrentProcessAudio=true` (macOS 13+), фильтр по приложениям.
- Минусы:
  - требует полное разрешение **Screen Recording** — промпт пугает сильнее;
  - в меню-баре горит индикатор записи экрана;
  - macOS 15+ периодически заново спрашивает подтверждение у приложений без системного picker;
  - нужен видеопоток, хоть и минимальный.
- Плюсы: работает на macOS 13 и 14.0–14.1; в macOS 15 умеет писать и микрофон.
- Вывод: имеет смысл только как фолбэк для старых систем. Проще поставить минимальную версию macOS 14.2.

**Ограничения и что не проверяли:**
- смена выходного устройства посреди звонка (подключили наушники);
- нагрузка на CPU;
- тап с `bundleIDs` / `processRestoreEnabled` (macOS 26) для исключения по bundle ID.
- Колбэк пишет в `Mutex<Vec>` — для прототипа это нормально, в продукте нужен lock-free ring buffer.

**Решение: идём.** Минимальная версия — macOS 14.2. Глобальный тап с исключением своих PID; выравнивание по host time; детект «нет разрешения» по нулям.

---

## 3. Windows (только компилируется)

`cargo check --target x86_64-pc-windows-msvc` проходит: crate `windows` 0.62, всё под `#[cfg(windows)]`, холодная проверка — 19 с. Имена сверены с исходниками `windows-0.62.2` (`Win32::Media::Audio`).

**3a. Loopback** — `audio-spike win-loopback` (`src/win/loopback.rs`) **[Win: компилируется]**:
- Основной путь:
  - `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IAudioClient, PROPVARIANT{VT_BLOB → AUDIOCLIENT_ACTIVATION_PARAMS{PROCESS_LOOPBACK, {our PID, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE}}})`;
  - completion handler через `#[implement]`;
  - `Initialize(SHARED, LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY)` с форматом, который задаём сами: PCM16, 48 кГц, стерео. `GetMixFormat` у process loopback не поддерживается **[док]**;
  - чтение через `IAudioCaptureClient`, поллинг каждые 10 мс.
- Фолбэк (`--legacy` или если активация упала): `AUDCLNT_STREAMFLAGS_LOOPBACK` на render-устройстве по умолчанию. Захватывает и наш собственный звук, а пока ничего не играет, пакеты не приходят **[док]** — нужно выравнивание по QPC из `GetBuffer`.
- Process loopback по документации требует Windows 10 build 20348+ или Windows 11. На Win10 19041–19045 по отзывам работает, но официально не гарантировано **[док]**.
- `--spawn CMD` запускает дочерний процесс, который входит в *наше* дерево процессов. Process loopback его слышать не должен, `--legacy` — должен.

**3b. Микрофон занят** — `audio-spike win-mic-sessions` (`src/win/mic_sessions.rs`) **[Win: компилируется]**:
- Алгоритм: для каждого активного capture endpoint: `IAudioSessionManager2 → IAudioSessionEnumerator → IAudioSessionControl2`. Сессия в `AudioSessionStateActive`, `pid != own`, `IsSystemSoundsSession() != S_OK` → «занят». Пишем PID, путь exe и имя устройства.
- Прототип опрашивает. В продукте вместо этого: `IAudioSessionNotification` (новые сессии) + `IAudioSessionEvents::OnStateChanged`.
- Альтернатива (`--registry`): `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\{app}` и `…\NonPackaged\{путь с #}`, значение `LastUsedTimeStop == 0` = «используется сейчас». Это то же, что питает системный индикатор микрофона; ловит и приложения не в shared-mode. Но это недокументированная деталь реализации, а исключать себя придётся по пути exe, а не по PID.
- Mute: по той же логике, что в п. 1, сессия звонилки при mute остаётся Active. Надо проверить.

**Решение: нужна проверка на Windows.** Код готов, инструкции ниже.

---

## 4. Эхоподавление без наушников

### 4a. macOS VoiceProcessingIO

**Что сделано** (`src/mac/au.rs`):
- `kAudioUnitSubType_VoiceProcessingIO` с явными входом и выходом (`kAudioOutputUnitProperty_CurrentDevice` на элементах 1 и 0), AGC выключен (`kAUVoiceIOProperty_VoiceProcessingEnableAGC=0`), режимы `vpio`, `vpio-bypass`, `vpio-input-only`;
- `kAUVoiceIOProperty_OtherAudioDuckingConfiguration` (2108, macOS 14+) = `{mEnableAdvancedDucking, mDuckingLevel}`;
- `echo-test` в одном процессе пишет raw-микрофон всё время: фаза A — только raw, фаза B — raw и VPIO параллельно, фаза C — снова только raw, фаза D — тишина; плюс тап (опорный сигнал). Дальний конец играет **отдельный процесс** на встроенные динамики (как Zoom), либо, с `--own-output`, сам VPIO.

**Результаты [M3]:**
- VPIO стартует за ~1.0 с, raw AUHAL — за 80 мс. Микрофон в обоих режимах отдаёт **нули**: нет TCC у T3 Code. **ERLE для VPIO не измерен.**
- **VPIO приглушает звук других приложений на −30 дБ.** Тест `tap-vpio-test`: отдельный процесс играет ровный тон 440 Гц, отдельный процесс пишет тап, VPIO в нашем процессе работает средние 4 с. Уровень в тапе: −13.5 dBFS до, **−43.5 dBFS во время**, −13.5 после. Результат одинаковый с ducking config Default, Min(10), Max(30)+advanced.
- Повтор на встроенных динамиках (`--spk MacBook --gain 0.05`, звук включён) показал провалы до −29…−35 dBFS во время VPIO. Но замер «грязный»: глобальный тап ловит и другой звук, который в это время играл в системе (до VPIO уровень −18…−20 dBFS вместо ожидаемых ~−29), поэтому основная цифра (−30 дБ) — из чистого прогона на MSI.
- Конфиг ducking: если выставить до `AudioUnitInitialize`, он читается обратно, но эффекта нет. После старта его тихо игнорирует (обратно читается 0).
- `vpio-bypass` (`kAUVoiceIOProperty_BypassVoiceProcessing=1`) приглушает так же. `vpio-input-only` (выход выключен) — `AudioUnitInitialize` → `-10875`.
- **VPIO меняет то, что пишет тап:** опорный сигнал и канал «Остальные» становятся на 30 дБ тише, плюс разрыв ~0.3 с на старте и остановке VPIO. С BT-наушниками как выходом по умолчанию (переключение профиля) потеряно ~5 с. Когда VPIO и тап в одном процессе, в тапе была секунда чистых нулей.
- Ducking применяется к потоку процесса до тапа, значит почти наверняка его слышит и пользователь: собеседник станет на 30 дБ тише. На слух не проверяли — команда ниже.
- Подавляет ли VPIO на macOS эхо **чужого** процесса, а не только своего выхода, — не проверено. Ответит `echo-test` после выдачи доступа к микрофону.

**Вывод:** VPIO для нас не подходит. Он глушит звонок и ломает опорный канал, ducking не отключается, а режима без выхода нет. Обходной путь — тап с `CATapMuted` на звонилку и проигрывание её звука через выход нашего VPIO, чтобы у VPIO был опорный сигнал. Это сложно и добавляет задержку; держим как запасной вариант, не основной.

### 4b. WebRTC AEC3 (кроссплатформенно, опорный сигнал = системный канал)

**Что сделано:**
- `sonora` 0.2 (чистый Rust, порт WebRTC APM: AEC3, NS, AGC2), кадры по 10 мс, 16 кГц;
- `aec-offline` — на любых двух WAV;
- `aec-sim` — синтетический «ноутбук без наушников»: `mic = near + h * far + шум`. `h` — задержка плюс экспоненциальный хвост (RT60 250 мс). Дальний конец — `say -v Milena` (ru), ближний — `say -v Lesya` (uk). 0–16 с — только дальний конец, 16–20.8 с — двойной разговор, 20.8–25.7 с — только ближний.

**Результаты (симуляция) [M3]:**

| Сценарий | ERLE (только дальний конец) | SNR ближнего конца при двойном разговоре: raw → AEC3 | SNR при одном ближнем конце: raw → AEC3 |
|---|---|---|---|
| задержка 60 мс, эхо −6 дБ | **22.5 дБ** | 5.8 → 3.6 | 35.7 → 18.4 |
| эхо 0 дБ (громкие динамики) | 14.7 дБ | −0.2 → −1.0 | 30.6 → 17.0 |
| задержка 200 мс | 25.0 дБ | 5.9 → 2.6 | 22.4 → 18.3 |
| задержка 450 мс | 28.5 дБ | 6.0 → 3.6 | 17.0 → 13.2 |
| дрейф часов 100 ppm | 17.0 дБ | 5.9 → 2.7 | 35.3 → 21.3 |
| нелинейность динамика + эхо 0 дБ | 16.2 дБ | −5.8 → −5.1 | 24.8 → 14.8 |

- По уровням эхо в «только дальний конец» падает с −23 до ~−60 dBFS (уровень шума) после 2–3 с сходимости. Такой остаток VAD как речь «Я» не примет.
- Уровень ближнего конца сохраняется (±1 дБ), но в двойном разговоре AEC3 заметно его режет: SNR по форме волны падает. **Как это влияет на WER, не проверяли.**
- SNR считается без HPF: один только фазовый сдвиг HPF «стоит» ~5 дБ. В продукте HPF оставляем.
- Скорость: 26.7 с аудио за 115 мс, **~230× реального времени** на одном ядре M3.
- Сборка: чистый Rust, `cargo check` под Windows проходит без C++-тулчейна. Холодная release-сборка всего крейта на M3 — 69 с.
- Альтернатива `webrtc-audio-processing` 2.1 (tonarino): C++, нужны meson, ninja, abseil, bindgen/libclang, objcopy, по умолчанию системная `.so`. В Windows CI это заметно дороже, на машине нет meson/ninja, собирать не стали.
- Также есть `aec3` 0.4 (aec3-rs) и `sonora-aec3` — не оценивали.
- Риск `sonora`: версия 0.2 и один мейнтейнер. Смягчается тем, что API повторяет WebRTC APM, и при проблемах можно перейти на C++-обёртку.

**Решение: меняем подход.** Основной вариант — AEC3 (`sonora`) на канале «Я» с тапом (macOS) или loopback (Windows) как опорным сигналом. AEC применяем только при выходе на встроенные динамики; с наушниками/BT его можно не включать — у AEC3 есть transparent mode.

Обязательно:
- выравнивать каналы по host time / QPC;
- держать задержку опорного сигнала в пределах 500 мс (лимит `set_stream_delay_ms`);
- проверить на реальной записи (`echo-test`) и посмотреть влияние на WER в двойном разговоре.

### 4c. Windows-нативный AEC [док]

- `IAcousticEchoCancellationControl` (Windows 11 22H2+, build 22621): для capture-потока категории Communications можно выбрать render endpoint как опорный сигнал AEC (`SetEchoCancellationRenderEndpoint`). Работает только если у устройства есть APO с AEC (OEM или Windows Voice Clarity в 24H2).
- Опорным будет весь микс endpoint, то есть и звонок — для нас это подходит.
- Наличие зависит от железа и драйвера, поэтому только как опция поверх AEC3, не основной путь.

---

## Что нужно сделать руками

1. **Разрешить микрофон** приложению, из которого запускаете команды. Проще всего Terminal.app: при первом запуске появится промпт. Потом:
   ```sh
   cd spikes/audio && cargo build --release
   ./target/release/audio-spike mic-record --mode raw --mic MacBook --secs 3 --out runs/mic.wav   # не должно быть "ALL ZEROS"
   # реальный тест эха: динамики MacBook ~50% громкости, 20 с речи из динамиков
   ./target/release/audio-spike echo-test --mic MacBook --spk MacBook --far data/far.wav --phase 6 --out-dir runs/echo
   ```
   Смотреть в выводе: `echo reduction vs raw B` (VPIO), `raw B change vs A` (ducking на динамиках), `AEC3 … with the process TAP as reference … ERLE`. Файлы лежат в `runs/echo/*.wav`.
2. **Послушать ducking:** `./target/release/audio-spike tap-vpio-test --secs 12 --mic MacBook --spk MacBook --gain 0.05` — тон 440 Гц в средней трети должен стать заметно тише.
3. **Mute в звонке:** `./target/release/audio-spike mic-watch --secs 300 --poll-ms 0`. Зайдите в Zoom или Meet, несколько раз выключите и включите микрофон, выйдите. Ожидаем: `OTHERS_USING_MIC` не меняется на mute и становится `false` при выходе. Отдельно стоит проверить Meet в Chrome и в Safari.
4. **Windows (x64, Windows 11 или Windows 10 22H2):**
   ```powershell
   # Rust (rustup) + Visual Studio Build Tools 2022 с "Desktop development with C++"
   cd spikes\audio; cargo build --release
   $B = ".\target\release\audio-spike.exe"
   & $B win-mic-sessions --secs 60 --registry      # за это время: запись в "Диктофоне", потом звонок Zoom/Teams с mute/unmute и выходом
   & $B win-loopback --secs 10 --out runs\loopback.wav   # параллельно играет YouTube; ждём ненулевой rms
   & $B win-loopback --secs 6 --spawn "powershell -c (New-Object Media.SoundPlayer 'C:\Windows\Media\Alarm01.wav').PlaySync()"            # своё дерево исключено -> тишина
   & $B win-loopback --secs 6 --legacy --spawn "powershell -c (New-Object Media.SoundPlayer 'C:\Windows\Media\Alarm01.wav').PlaySync()"   # endpoint loopback -> звук есть
   & $B aec-sim --far far.wav --near near.wav       # WAV скопировать из spikes/audio/data на Mac (на Windows нет `say`)
   ```
   Если `win-loopback` пишет `process loopback unavailable`, значит сборка Windows ниже 20348 и работает фолбэк. Сообщите номер сборки (`winver`).

## Как воспроизвести (macOS)

Все команды ограничены по времени. `./run-mac.sh [mic] [speaker]` прогоняет пункты 1, 2, 4 подряд; последним шагом идёт `echo-test`, которому нужен микрофон.

```sh
cd spikes/audio && cargo build --release && B=$PWD/target/release/audio-spike
$B devices
# 1. детект: нормальный выход / SIGKILL / свой захват
$B mic-watch --secs 5 --poll-ms 5 --device MacBook --spawn "$B mic-record --mode raw --mic MacBook --secs 2 --out /tmp/x.wav" --spawn-at 1
$B mic-watch --secs 5 --poll-ms 5 --device MacBook --spawn "$B mic-record --mode raw --mic MacBook --secs 10 --out /tmp/x.wav" --spawn-at 1 --kill-after 1.5
$B mic-watch --secs 4 --poll-ms 5 --device MacBook --self-capture 2
SPIKE_DEBUG=1 SPIKE_PROC_SELECTOR='****' SPIKE_WILDCARD_SCOPE=1 $B mic-watch --secs 5 --device MacBook --spawn "$B mic-record --mode raw --mic MacBook --secs 2 --out /tmp/x.wav" --spawn-at 1   # какие селекторы реально приходят
SPIKE_ONLY_PIRI=1 $B mic-watch --secs 5 --poll-ms 5 --device MacBook --spawn "$B mic-record --mode raw --mic MacBook --secs 2 --out /tmp/x.wav" --spawn-at 1   # только 'piri': слушатель молчит
# 2. тап
$B tap-record --secs 4 --self-tone 1000 --out runs/tap.wav --spawn "say 'one two three four five six seven'"
$B tap-record --secs 4 --self-tone 1000 --include-self --out runs/tap-incl.wav --spawn "say 'one two three four five six seven'"
$B tap-record --secs 3 --main-device none --out /tmp/t.wav                                     # тишина -> 0 колбэков
$B tap-record --secs 24 --main-device MacBook --out runs/gap.wav --spawn "sh -c 'say one two; sleep 18; say three four'"   # без разрывов
# 4. VPIO против тапа (MSI — внешний монитор без звука; подставьте любой выход)
$B tap-vpio-test --secs 12 --mic MacBook --spk MSI [--ducking 10|30] [--advanced-ducking] [--mode vpio|vpio-bypass|vpio-input-only]
$B aec-sim [--erl-db 0] [--delay-ms 200] [--drift-ppm 100] [--nonlinear]
$B aec-offline --mic runs/echo/raw.wav --ref runs/echo/tap.wav --align --out runs/aec3.wav
# Windows-код
cargo check --target x86_64-pc-windows-msvc
```
