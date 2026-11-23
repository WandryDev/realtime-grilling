"use client";

import { useCallback } from "react";

import type { InputDevice, ModelId, SpeechModel } from "@/bindings";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import type { ScreenAudioAccess } from "@/data/onboarding-setup";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
  type StoredBenchmark,
} from "@/data/settings";
import type { CaptureProblem } from "@/features/onboarding/api";
import {
  AgentSidebarStatusItem,
  SidebarStatus,
  SidebarStatusItem,
} from "@/features/shell/app-sidebar";
import { MicIcon } from "@/features/shell/icons";

import {
  LevelMeter,
  SettingsRadioRow,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { momentLabel } from "../format";
import { DownloadIcon, MicOffIcon, PlayIcon } from "../icons";
import {
  DISCONNECTED_MICROPHONE,
  MICROPHONES,
  SPEECH_BENCHMARK,
  SPEECH_MODEL_NOTES,
  SPEECH_MODELS,
} from "../mock";

/** The chosen microphone is not among the devices. */
export interface MissingMicrophone {
  name: string;
  /** When it went missing (ms since the epoch), if known. */
  since: number | null;
}

export type SoundCheckState =
  | { status: "idle" }
  | { status: "running" }
  /** `text` is empty when nothing was recognized. */
  | { status: "done"; text: string }
  /** Why it can't check: no model, no access. */
  | { message: string; status: "failed" };

/** A level meter's source: its level, 0–100, or why it can't be opened. */
export interface InputLevel {
  level: number;
  problem: CaptureProblem | null;
}

/** The value of «Как в системе» in the `microphone` setting. */
export const SYSTEM_MICROPHONE = "system";

const PROBLEM_CAPTIONS: Record<CaptureProblem, string> = {
  busy: "занято",
  failed: "не открылся",
  noAccess: "нет доступа",
  noDevice: "нет устройства",
};

const SYSTEM_ACCESS: Record<ScreenAudioAccess, string> = {
  asking: "Доступ к системному звуку ещё не выдан",
  denied: "Нет доступа к системному звуку: включите его в Системных настройках",
  granted: "Доступ к системному звуку есть",
  idle: "Доступ к системному звуку ещё не выдан",
  unknown: "macOS не говорит, есть ли доступ: смотрите на индикатор",
};

/**
 * Red banner on top of the page while the chosen microphone is gone. On a
 * narrow panel the button moves under the text instead of squeezing it.
 */
function MicrophoneDisconnectedBanner({
  missing,
  onUseDefault,
}: {
  missing: MissingMicrophone;
  onUseDefault?: () => void;
}) {
  const since =
    missing.since === null ? "" : `Отключён с ${momentLabel(missing.since)}. `;
  return (
    <Alert
      className="gap-x-3.5 py-4 pr-4 pl-5 *:[svg]:size-[18px]"
      variant="destructive"
    >
      <MicOffIcon />
      <AlertTitle>Микрофон «{missing.name}» отключён</AlertTitle>
      <AlertDescription className="text-foreground">
        {since}Пока его нет, Grill слушает микрофон по умолчанию. Подключите его
        снова или возьмите микрофон по умолчанию
      </AlertDescription>
      <AlertAction className="*:data-[slot=button]:bg-primary *:data-[slot=button]:text-primary-foreground *:data-[slot=button]:hover:bg-ink-hover *:data-[slot=button]:active:bg-ink-active @max-2xl/panel:col-start-2! @max-2xl/panel:row-span-1! @max-2xl/panel:row-start-3! @max-2xl/panel:pt-3">
        <Button onClick={onUseDefault}>Взять микрофон по умолчанию</Button>
      </AlertAction>
    </Alert>
  );
}

/** «Как в системе», then the devices; the missing chosen one stays listed. */
function microphoneOptions(
  devices: readonly InputDevice[],
  missing: MissingMicrophone | null
) {
  return [
    { label: "Как в системе", value: SYSTEM_MICROPHONE },
    ...devices.map((device) => ({ label: device.name, value: device.id })),
    ...(missing
      ? [{ label: `${missing.name}, нет связи`, value: missing.name }]
      : []),
  ];
}

function levelCaption({ level, problem }: InputLevel, sound: string) {
  if (problem) {
    return PROBLEM_CAPTIONS[problem];
  }
  return level > SILENCE_LEVEL ? sound : "тишина";
}

/** Download in progress: a 120 wide bar with the percent. */
function ModelProgress({
  name,
  paused = false,
  value,
}: {
  name: string;
  paused?: boolean;
  value: number;
}) {
  return (
    <div className="flex w-30 shrink-0 items-center gap-2">
      <Progress
        aria-label={`Загрузка ${name}`}
        className="flex-1"
        size="sm"
        tone={paused ? "paused" : "active"}
        value={value}
      />
      <span className="text-muted-foreground w-8 text-right font-mono text-xs">
        {Math.round(value)}%
      </span>
    </div>
  );
}

const BYTES_PER_MB = 1_000_000;
const MB_PER_GB = 1000;

/** "574 МБ", "1,2 ГБ": decimal units, as macOS counts disk space. */
function formatBytes(bytes: number) {
  const mb = bytes / BYTES_PER_MB;
  if (mb < MB_PER_GB) {
    return `${Math.round(mb)} МБ`;
  }
  return `${(mb / MB_PER_GB).toFixed(1).replace(".", ",")} ГБ`;
}

/** The line under a model's name: what it is for, or what went wrong. */
function modelDescription(model: SpeechModel) {
  const { state } = model;
  switch (state.status) {
    case "noSpace":
      return `Не хватает места: нужно ${formatBytes(state.needBytes)}, свободно ${formatBytes(state.freeBytes)}`;
    case "noNetwork":
      return `Нет сети, загрузка прервалась на ${Math.round(state.percent)}%. Продолжим сами`;
    case "error":
      return state.reason === "checksum"
        ? "Файл скачался с ошибкой и удалён, скачайте заново"
        : state.message;
    case "checking":
      return "Проверяем файл после загрузки";
    default:
      return SPEECH_MODEL_NOTES[model.id];
  }
}

export interface SpeechModelActions {
  /** "Скачать", "Продолжить", "Повторить". */
  onDownload?: (id: ModelId) => void;
  /** "Скачать заново": a broken model goes and comes again. */
  onRedownload?: (id: ModelId) => void;
  onRemove?: (id: ModelId) => void;
}

function ModelAction({
  actions,
  disabled,
  model,
}: {
  actions: SpeechModelActions;
  disabled: boolean;
  model: SpeechModel;
}) {
  const { id, name, state } = model;
  const broken = state.status === "error";
  const download = useCallback(() => {
    if (broken) {
      actions.onRedownload?.(id);
    } else {
      actions.onDownload?.(id);
    }
  }, [actions, broken, id]);
  const remove = useCallback(() => actions.onRemove?.(id), [actions, id]);
  switch (state.status) {
    case "downloading":
      return <ModelProgress name={name} value={state.percent} />;
    case "checking":
      return <ModelProgress name={name} value={100} />;
    case "paused":
    case "noNetwork":
      return (
        <Button
          className="w-30"
          disabled={disabled}
          onClick={download}
          variant="secondary"
        >
          {state.status === "paused" ? "Продолжить" : "Повторить"}
        </Button>
      );
    case "ready":
      return (
        <Button
          className="text-muted-foreground w-30"
          disabled={disabled && model.selected}
          onClick={remove}
          variant="ghost"
        >
          Удалить
        </Button>
      );
    default:
      return (
        <Button
          className="text-muted-foreground w-30"
          disabled={disabled}
          onClick={download}
          variant="ghost"
        >
          <DownloadIcon className="size-3.5" />
          {broken ? "Скачать заново" : "Скачать"}
        </Button>
      );
  }
}

function SpeechModelRow({
  actions,
  disabled = false,
  model,
}: {
  actions: SpeechModelActions;
  disabled?: boolean;
  model: SpeechModel;
}) {
  return (
    <SettingsRadioRow
      align="center"
      description={modelDescription(model)}
      disabled={disabled || model.state.status !== "ready"}
      title={model.name}
      trailing={
        <>
          <span className="text-muted-foreground w-16 shrink-0 text-right font-mono text-xs">
            {formatBytes(model.sizeBytes)}
          </span>
          <ModelAction actions={actions} disabled={disabled} model={model} />
        </>
      }
      value={model.id}
    />
  );
}

const PERCENT = 100;

function formatSeconds(ms: number) {
  return (ms / 1000).toFixed(1).replace(".", ",");
}

/** The hardware check of the selected model in one line. */
export function benchmarkSummary(result: StoredBenchmark | undefined) {
  if (!result) {
    return "Ещё не проверяли на этом компьютере";
  }
  const errors = `ошибок ${Math.round(result.wer * PERCENT)}%`;
  if (result.passed) {
    return `Успевает: фраза расшифровывается за ${formatSeconds(result.p95Ms)} с, ${errors}`;
  }
  switch (result.reason) {
    case "inaccurate":
      return `Распознаёт неправильно: ${errors}. Скачайте модель заново`;
    case "modelFailed":
      return "Модель не запустилась, скачайте её заново";
    case "noModel":
      return "Модель не скачана";
    default:
      return `Не успевает: фраза за ${formatSeconds(result.p95Ms)} с, нужно до 3 с. Живая расшифровка будет отставать, полная появится после звонка`;
  }
}

/** «Проверить» the first time, «Проверить снова» after a result. */
function benchmarkLabel({ result, running }: BenchmarkState) {
  if (running) {
    return "Проверяю…";
  }
  return result ? "Проверить снова" : "Проверить";
}

export interface BenchmarkState {
  /** The last result of the selected model, if any. */
  result?: StoredBenchmark;
  /** The check runs now. */
  running: boolean;
}

/** What the sound check heard, or why it couldn't, under its row. */
function SoundCheckResult({ state }: { state: SoundCheckState }) {
  if (state.status === "failed") {
    return <p className="text-contradiction text-sm">{state.message}</p>;
  }
  if (state.status !== "done") {
    return null;
  }
  return (
    <dl
      aria-label="Результат проверки звука"
      className="bg-surface flex flex-col gap-1.5 rounded-sm px-3.5 py-3 text-sm"
    >
      <div className="flex gap-2">
        <dt className="text-muted-foreground w-16 shrink-0">Вы</dt>
        <dd>
          {state.text.trim()
            ? `«${state.text.trim()}»`
            : "Ничего не расслышал: скажите погромче"}
        </dd>
      </div>
    </dl>
  );
}

const SILENCE_LEVEL = 5;

const NO_MODEL_ACTIONS: SpeechModelActions = {};

/** A moment of the demo's disconnected headphones, 12 November 12:41. */
const DEMO_MISSING_SINCE = new Date(2026, 10, 12, 12, 41).getTime();

const PREVIEW_LEVELS = {
  microphone: { level: 58, problem: null },
  system: { level: 4, problem: null },
} satisfies Record<"microphone" | "system", InputLevel>;

/**
 * "Звук и распознавание": both audio channels, sound check, speech model.
 * The microphones are the computer's (`microphones`); `missing` is the
 * chosen one when it is gone. During a call (`inCall`) devices and the
 * model can't change.
 */
export function AudioSettings({
  benchmark = { result: SPEECH_BENCHMARK, running: false },
  inCall = false,
  levels = PREVIEW_LEVELS,
  microphones = MICROPHONES,
  missing = null,
  modelActions = NO_MODEL_ACTIONS,
  models = SPEECH_MODELS,
  onChange,
  onRecheck,
  onSelectModel,
  onSoundCheck,
  onUseDefaultMic,
  soundCheck = { status: "idle" },
  systemAccess = "granted",
  values = DEFAULT_SETTINGS,
}: {
  /** The hardware check of the selected model. */
  benchmark?: BenchmarkState;
  inCall?: boolean;
  /** Live input levels, 0–100, or why a source can't be opened. */
  levels?: { microphone: InputLevel; system: InputLevel };
  /** The input devices of the computer. */
  microphones?: readonly InputDevice[];
  /** The chosen microphone is gone: the banner and «нет связи». */
  missing?: MissingMicrophone | null;
  /** "Скачать", "Продолжить", "Удалить" of a model. */
  modelActions?: SpeechModelActions;
  /** Both speech models, as the backend reports them. */
  models?: readonly SpeechModel[];
  onChange?: SettingChange;
  /** «Проверить» / «Проверить снова»: the hardware check of the selected model. */
  onRecheck?: () => void;
  /** A ready model picked to recognize with. */
  onSelectModel?: (id: ModelId) => void;
  onSoundCheck?: () => void;
  /** «Взять микрофон по умолчанию»: «Как в системе». */
  onUseDefaultMic?: () => void;
  soundCheck?: SoundCheckState;
  /** The access to the system audio, from the permissions check. */
  systemAccess?: ScreenAudioAccess;
  values?: SettingsValues;
}) {
  const checking = soundCheck.status === "running";
  const selected = models.find((model) => model.selected);
  const modelReady = selected?.state.status === "ready";
  const canRecheck = !(inCall || benchmark.running) && modelReady;
  let benchmarkLine = benchmarkSummary(benchmark.result);
  if (benchmark.running) {
    benchmarkLine = "Расшифровываю проверочные фразы, это до двух минут";
  } else if (!modelReady) {
    benchmarkLine = "Сначала скачайте модель";
  }
  const pickModel = useCallback(
    (value: unknown) => {
      const picked = models.find((model) => model.id === value);
      if (picked) {
        onSelectModel?.(picked.id);
      }
    },
    [models, onSelectModel]
  );

  return (
    <>
      {missing ? (
        <MicrophoneDisconnectedBanner
          missing={missing}
          onUseDefault={onUseDefaultMic}
        />
      ) : null}
      <SettingsSection className="pt-4" title="Источники звука">
        <SettingsRow
          align="start"
          control={
            <div className="flex w-70 max-w-full flex-col gap-2.5">
              <SettingsSelect
                className="w-full"
                defaultValue={values.microphone}
                disabled={inCall}
                id="settings-microphone"
                invalid={Boolean(missing)}
                onSettingChange={onChange}
                options={microphoneOptions(microphones, missing)}
                setting="microphone"
              />
              {missing?.since ? (
                <p className="text-contradiction px-0.5 text-xs">
                  Нет связи с {momentLabel(missing.since)}, слушаю микрофон по
                  умолчанию
                </p>
              ) : null}
              <LevelMeter
                caption={levelCaption(levels.microphone, "слышу вас")}
                label="Уровень микрофона"
                value={levels.microphone.level}
              />
            </div>
          }
          description="Ваш голос в расшифровке"
          htmlFor="settings-microphone"
          title="Микрофон, канал «Вы»"
        />
        <SettingsRow
          align="start"
          control={
            <div className="flex w-70 max-w-full flex-col gap-2.5">
              <LevelMeter
                caption={levelCaption(levels.system, "слышу звук")}
                label="Уровень системного звука"
                value={levels.system.level}
              />
              <p className="text-muted-foreground px-0.5 text-xs">
                {SYSTEM_ACCESS[systemAccess]}
              </p>
            </div>
          }
          description="Звук других приложений, без звука Grill: Zoom, Meet, Telegram"
          title="Системный звук, канал «Клиент»"
        />
        <SettingsRow
          control={
            <Button
              disabled={checking}
              onClick={onSoundCheck}
              variant="secondary"
            >
              {checking ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : (
                <PlayIcon className="size-3.5" />
              )}
              {checking ? "Слушаю…" : "Проверить звук"}
            </Button>
          }
          description="Скажите пару фраз в выбранный микрофон, Grill покажет, что расслышал"
          title="Проверка звука"
        >
          <SoundCheckResult state={soundCheck} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection className="pt-12" title="Модель распознавания">
        <RadioGroup
          aria-label="Модель распознавания"
          className="gap-7"
          onValueChange={pickModel}
          value={selected?.id ?? ""}
        >
          {models.map((model) => (
            <SpeechModelRow
              actions={modelActions}
              disabled={inCall}
              key={model.id}
              model={model}
            />
          ))}
        </RadioGroup>
        <SettingsRow
          control={
            <Button
              disabled={!canRecheck}
              onClick={onRecheck}
              variant="secondary"
            >
              {benchmark.running ? (
                <Spinner aria-hidden="true" className="size-3.5" />
              ) : null}
              {benchmarkLabel(benchmark)}
            </Button>
          }
          description={benchmarkLine}
          title="Успевает ли компьютер"
        />
      </SettingsSection>
    </>
  );
}

/** Sidebar status while the microphone is missing: red "Нет микрофона". */
export function NoMicrophoneStatus() {
  return (
    <SidebarStatus>
      <AgentSidebarStatusItem />
      <SidebarStatusItem
        description="пишу с микрофона по умолчанию"
        icon={<MicIcon />}
        title="Нет микрофона"
        tone="error"
      />
    </SidebarStatus>
  );
}

export function AudioSettingsScreen({
  className,
  microphone = "ok",
}: {
  className?: string;
  microphone?: "ok" | "disabled";
}) {
  const micDisabled = microphone === "disabled";
  return (
    <SettingsScreen
      alerts={micDisabled ? ["audio"] : undefined}
      className={className}
      section="audio"
      status={micDisabled ? <NoMicrophoneStatus /> : undefined}
    >
      <AudioSettings
        microphones={MICROPHONES.filter(
          (device) => !micDisabled || device.name !== DISCONNECTED_MICROPHONE
        )}
        missing={
          micDisabled
            ? { name: DISCONNECTED_MICROPHONE, since: DEMO_MISSING_SINCE }
            : null
        }
        values={
          micDisabled
            ? { ...DEFAULT_SETTINGS, microphone: DISCONNECTED_MICROPHONE }
            : DEFAULT_SETTINGS
        }
      />
    </SettingsScreen>
  );
}
