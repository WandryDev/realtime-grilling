"use client";

import { useCallback } from "react";

import type { ModelId, SpeechModel } from "@/bindings";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
  type StoredBenchmark,
} from "@/data/settings";
import { SidebarStatus, SidebarStatusItem } from "@/features/shell/app-sidebar";
import { MicIcon } from "@/features/shell/icons";

import {
  LevelMeter,
  SettingsRadioRow,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { DownloadIcon, MicOffIcon, PlayIcon } from "../icons";
import {
  DISCONNECTED_MICROPHONE,
  MICROPHONES,
  SPEECH_BENCHMARK,
  SPEECH_MODEL_NOTES,
  SPEECH_MODELS,
  SYSTEM_AUDIO_SOURCES,
} from "../mock";

type MicrophoneState = "ok" | "disabled";

export type SoundCheckState =
  | { status: "idle" }
  | { status: "running" }
  | { client: string; status: "done"; you: string };

/** Red banner on top of the page while the chosen microphone is gone. */
function MicrophoneDisconnectedBanner({
  name,
  onUseBuiltIn,
}: {
  name: string;
  onUseBuiltIn?: () => void;
}) {
  return (
    <Alert
      className="gap-x-3.5 py-4 pr-4 pl-5 *:[svg]:size-[18px]"
      variant="destructive"
    >
      <MicOffIcon />
      <AlertTitle>Микрофон «{name}» отключён</AlertTitle>
      <AlertDescription className="text-foreground">
        Пока его нет, ваш голос не попадёт в расшифровку. Подключите наушники
        или выберите встроенный микрофон
      </AlertDescription>
      <AlertAction className="*:data-[slot=button]:bg-primary *:data-[slot=button]:text-primary-foreground *:data-[slot=button]:hover:bg-ink-hover *:data-[slot=button]:active:bg-ink-active">
        <Button onClick={onUseBuiltIn}>Взять микрофон MacBook</Button>
      </AlertAction>
    </Alert>
  );
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
      className="py-4.5"
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

export interface BenchmarkState {
  /** The last result of the selected model, if any. */
  result?: StoredBenchmark;
  /** The check runs now. */
  running: boolean;
}

/** What the sound check heard, under its row. */
function SoundCheckResult({ client, you }: { client: string; you: string }) {
  return (
    <dl
      aria-label="Результат проверки звука"
      className="bg-surface flex flex-col gap-1.5 rounded-sm px-3.5 py-3 text-sm"
    >
      <div className="flex gap-2">
        <dt className="text-muted-foreground w-16 shrink-0">Вы</dt>
        <dd>{you}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground w-16 shrink-0">Клиент</dt>
        <dd>{client}</dd>
      </div>
    </dl>
  );
}

const SILENCE_LEVEL = 5;

const NO_MODEL_ACTIONS: SpeechModelActions = {};

/**
 * "Звук и распознавание": both audio channels, sound check, speech model.
 * During a call (`inCall`) devices and the model can't change.
 */
export function AudioSettings({
  benchmark = { result: SPEECH_BENCHMARK, running: false },
  inCall = false,
  levels = { microphone: 58, system: 4 },
  microphone = "ok",
  modelActions = NO_MODEL_ACTIONS,
  models = SPEECH_MODELS,
  onChange,
  onPickMicrophone,
  onRecheck,
  onSelectModel,
  onSoundCheck,
  onUseBuiltInMic,
  soundCheck = { status: "idle" },
  values = DEFAULT_SETTINGS,
}: {
  /** The hardware check of the selected model. */
  benchmark?: BenchmarkState;
  inCall?: boolean;
  /** Live input levels, 0–100. */
  levels?: { microphone: number; system: number };
  microphone?: MicrophoneState;
  /** "Скачать", "Продолжить", "Удалить" of a model. */
  modelActions?: SpeechModelActions;
  /** Both speech models, as the backend reports them. */
  models?: readonly SpeechModel[];
  onChange?: SettingChange;
  /** A device picked while the chosen microphone is missing. */
  onPickMicrophone?: (value: string) => void;
  /** "Проверить снова": the hardware check of the selected model. */
  onRecheck?: () => void;
  /** A ready model picked to recognize with. */
  onSelectModel?: (id: ModelId) => void;
  onSoundCheck?: () => void;
  onUseBuiltInMic?: () => void;
  soundCheck?: SoundCheckState;
  values?: SettingsValues;
}) {
  const micDisabled = microphone === "disabled";
  const checking = soundCheck.status === "running";
  const selected = models.find((model) => model.selected);
  const canRecheck =
    !(inCall || benchmark.running) && selected?.state.status === "ready";
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
      {micDisabled ? (
        <MicrophoneDisconnectedBanner
          name={DISCONNECTED_MICROPHONE.name}
          onUseBuiltIn={onUseBuiltInMic}
        />
      ) : null}
      <SettingsSection className="pt-4" title="Источники звука">
        <SettingsRow
          align="start"
          control={
            <div className="flex w-70 flex-col gap-2.5">
              {micDisabled ? (
                <>
                  <SettingsSelect
                    className="w-full"
                    defaultValue="missing"
                    disabled={inCall}
                    id="settings-microphone"
                    invalid
                    // A different control than the bound one below: remount.
                    key="missing"
                    onValueChange={onPickMicrophone}
                    options={[
                      {
                        label: DISCONNECTED_MICROPHONE.label,
                        value: "missing",
                      },
                      ...MICROPHONES,
                    ]}
                    valueClassName="text-muted-foreground"
                  />
                  <p className="text-contradiction px-0.5 text-xs">
                    {DISCONNECTED_MICROPHONE.hint}
                  </p>
                </>
              ) : (
                <>
                  <SettingsSelect
                    className="w-full"
                    defaultValue={values.microphone}
                    disabled={inCall}
                    id="settings-microphone"
                    key="chosen"
                    onSettingChange={onChange}
                    options={MICROPHONES}
                    setting="microphone"
                  />
                  <LevelMeter
                    caption={
                      levels.microphone > SILENCE_LEVEL ? "слышу вас" : "тишина"
                    }
                    label="Уровень микрофона"
                    value={levels.microphone}
                  />
                </>
              )}
            </div>
          }
          description="Ваш голос в расшифровке"
          htmlFor="settings-microphone"
          title="Микрофон, канал «Вы»"
        />
        <SettingsRow
          align="start"
          control={
            <div className="flex w-70 flex-col gap-2.5">
              <SettingsSelect
                className="w-full"
                defaultValue={values.systemAudio}
                disabled={inCall}
                id="settings-system-audio"
                onSettingChange={onChange}
                options={SYSTEM_AUDIO_SOURCES}
                setting="systemAudio"
              />
              <LevelMeter
                caption={
                  levels.system > SILENCE_LEVEL ? "слышу звук" : "тишина"
                }
                label="Уровень системного звука"
                value={levels.system}
              />
            </div>
          }
          description="Всё, что слышно в наушниках: Zoom, Meet, Telegram"
          htmlFor="settings-system-audio"
          title="Системный звук, канал «Клиент»"
        />
        <SettingsRow
          control={
            <Button
              disabled={checking || micDisabled}
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
          description="Скажите пару фраз и включите любое видео, Grill покажет, что расслышал"
          title="Проверка звука"
        >
          {soundCheck.status === "done" ? (
            <SoundCheckResult client={soundCheck.client} you={soundCheck.you} />
          ) : null}
        </SettingsRow>
      </SettingsSection>
      <SettingsSection className="pt-8" title="Модель распознавания">
        <RadioGroup
          aria-label="Модель распознавания"
          className="gap-0"
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
              {benchmark.running ? "Проверяю…" : "Проверить снова"}
            </Button>
          }
          description={
            benchmark.running
              ? "Расшифровываю проверочные фразы, это до двух минут"
              : benchmarkSummary(benchmark.result)
          }
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
      <SidebarStatusItem
        description="готов к звонку"
        icon={<ClaudeIcon />}
        title="Claude Code"
        tone="ready"
      />
      <SidebarStatusItem
        description="звонок не запишется"
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
  microphone?: MicrophoneState;
}) {
  const micDisabled = microphone === "disabled";
  return (
    <SettingsScreen
      alerts={micDisabled ? ["audio"] : undefined}
      className={className}
      section="audio"
      status={micDisabled ? <NoMicrophoneStatus /> : undefined}
    >
      <AudioSettings microphone={microphone} />
    </SettingsScreen>
  );
}
