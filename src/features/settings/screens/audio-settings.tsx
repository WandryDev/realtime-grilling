"use client";

import { type ReactNode, useCallback } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";
import { SidebarStatus, SidebarStatusItem } from "@/features/shell/app-sidebar";
import { MicIcon } from "@/features/shell/icons";

import {
  LevelMeter,
  SettingsRadioGroup,
  SettingsRadioRow,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { DownloadIcon, MicOffIcon, PlayIcon, RefreshIcon } from "../icons";
import {
  DISCONNECTED_MICROPHONE,
  MICROPHONES,
  SPEECH_MODELS,
  type SpeechModel,
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

/** "есть обновление": soft orange pill with a dot. */
function UpdateBadge() {
  return (
    <Badge className="h-[22px] px-2 text-xs" variant="waiting">
      <span aria-hidden="true" className="bg-accent size-1.5 rounded-full" />
      есть обновление
    </Badge>
  );
}

/** Download or update in progress: a 120 wide bar with the percent. */
function ModelProgress({ name, value }: { name: string; value: number }) {
  return (
    <div className="flex w-30 shrink-0 items-center gap-2">
      <Progress
        aria-label={`Загрузка ${name}`}
        className="flex-1"
        size="sm"
        tone="active"
        value={value}
      />
      <span className="text-muted-foreground w-8 text-right font-mono text-xs">
        {value}%
      </span>
    </div>
  );
}

function SpeechModelRow({
  disabled,
  model,
  onDownload,
  progress,
}: {
  disabled?: boolean;
  model: SpeechModel;
  /** Download (not installed) or update (installed, update available). */
  onDownload?: (id: string) => void;
  /** Percent of the running download or update. */
  progress?: number;
}) {
  const handleDownload = useCallback(() => {
    onDownload?.(model.id);
  }, [model.id, onDownload]);

  let action: ReactNode = (
    <Button
      className="text-muted-foreground w-30"
      disabled={disabled}
      onClick={handleDownload}
      variant="ghost"
    >
      <DownloadIcon className="size-3.5" />
      Скачать
    </Button>
  );
  if (progress !== undefined) {
    action = <ModelProgress name={model.name} value={progress} />;
  } else if (model.installed && model.update) {
    action = (
      <Button
        className="w-30"
        disabled={disabled}
        onClick={handleDownload}
        variant="secondary"
      >
        <RefreshIcon className="size-3.5" />
        Обновить
      </Button>
    );
  } else if (model.installed) {
    action = (
      <span className="text-muted-foreground w-30 shrink-0 text-center text-sm">
        Последняя версия
      </span>
    );
  }

  return (
    <SettingsRadioRow
      align="center"
      badge={
        model.update && progress === undefined ? <UpdateBadge /> : undefined
      }
      className="py-4.5"
      description={model.description}
      disabled={disabled || !model.installed}
      title={model.name}
      trailing={
        <>
          <span className="text-muted-foreground w-16 shrink-0 text-right font-mono text-xs">
            {model.size}
          </span>
          {action}
        </>
      }
      value={model.id}
    />
  );
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

/**
 * "Звук и распознавание": both audio channels, sound check, speech model.
 * During a call (`inCall`) devices and the model can't change.
 */
export function AudioSettings({
  inCall = false,
  levels = { microphone: 58, system: 4 },
  microphone = "ok",
  modelProgress = {},
  onChange,
  onDownloadModel,
  onPickMicrophone,
  onSoundCheck,
  onUseBuiltInMic,
  soundCheck = { status: "idle" },
  values = DEFAULT_SETTINGS,
}: {
  inCall?: boolean;
  /** Live input levels, 0–100. */
  levels?: { microphone: number; system: number };
  microphone?: MicrophoneState;
  /** Running downloads and updates, percent by model id. */
  modelProgress?: Record<string, number>;
  onChange?: SettingChange;
  onDownloadModel?: (id: string) => void;
  /** A device picked while the chosen microphone is missing. */
  onPickMicrophone?: (value: string) => void;
  onSoundCheck?: () => void;
  onUseBuiltInMic?: () => void;
  soundCheck?: SoundCheckState;
  values?: SettingsValues;
}) {
  const micDisabled = microphone === "disabled";
  const models = SPEECH_MODELS.map((model) => ({
    ...model,
    installed: values.installedModels.includes(model.id),
    update: values.modelUpdates.includes(model.id),
  }));
  const checking = soundCheck.status === "running";

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
        <SettingsRadioGroup
          aria-label="Модель распознавания"
          defaultValue={values.speechModel}
          onSettingChange={onChange}
          setting="speechModel"
        >
          {models.map((model) => (
            <SpeechModelRow
              disabled={inCall}
              key={model.id}
              model={model}
              onDownload={onDownloadModel}
              progress={modelProgress[model.id]}
            />
          ))}
        </SettingsRadioGroup>
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
