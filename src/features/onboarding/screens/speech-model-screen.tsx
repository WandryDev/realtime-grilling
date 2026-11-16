import { Button } from "@/components/ui/button";
import { ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckIcon,
  CrossIcon,
  DiskIcon,
  DownloadIcon,
  InfoIcon,
  WaveformIcon,
  WifiOffIcon,
} from "../components/icons";
import { LanguagePicker } from "../components/language-picker";
import { MicCheck } from "../components/mic-check";
import {
  ModelBar,
  ModelBarCaption,
  ModelRow,
  ModelSection,
} from "../components/model-section";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "../components/onboarding-window";
import { StepHeading } from "../components/step-heading";
import { StepBackButton, StepNextButton } from "../components/step-links";
import { StepNote } from "../components/step-note";
import {
  SPEECH_LANGUAGES,
  SPEECH_MODEL,
  type SpeechLanguage,
  type SpeechModelInfo,
} from "../mock";

/*
 * 03 Модель речи.
 * - language: pick the language, the model isn't downloaded yet
 * - downloading: progress with pause and cancel, the step can be left
 * - checking: the checksum after the download, then the hardware check
 * - ready: model on disk, the mic check
 * - check-failed: the computer is too slow (the small model is offered) or
 *   the model recognizes wrong; the step can still be left
 * - no-space / no-network / error: the download stopped, how to fix it
 *
 * The app passes `handlers` and `paused` (a paused download is the
 * downloading state with "Продолжить" instead of "Пауза").
 */
export type SpeechModelState =
  | "language"
  | "downloading"
  | "checking"
  | "ready"
  | "check-failed"
  | "no-space"
  | "no-network"
  | "error";

export interface SpeechModelHandlers {
  onCancel?: () => void;
  onDownload?: () => void;
  /** "Скачать запасную модель". */
  onDownloadFallback?: () => void;
  onLanguageChange?: (language: string) => void;
  /** "Проверить ещё раз" under the mic check. */
  onMicCheckAgain?: () => void;
  onOpenStorage?: () => void;
  onPause?: () => void;
  /** "Проверить снова": the hardware check. */
  onRecheck?: () => void;
  /** "Скачать заново": a broken model. */
  onRedownload?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
}

interface ModelPartProps {
  handlers: SpeechModelHandlers;
  model: SpeechModelInfo;
  paused: boolean;
}

function ModelOffer({ handlers, model }: ModelPartProps) {
  return (
    <ModelSection>
      <ModelRow
        action={
          <Button className="h-9 px-4" onClick={handlers.onDownload}>
            <DownloadIcon className="size-3.5" />
            Скачать
          </Button>
        }
        description={
          model.freeSpace
            ? `${model.size}, на диске свободно ${model.freeSpace}`
            : model.size
        }
        icon={<WaveformIcon />}
        title={model.title}
      />
      <p className="text-muted-foreground text-sm">
        Скачивание занимает 2–3 минуты. Язык можно поменять потом в настройках.
      </p>
    </ModelSection>
  );
}

function ModelDownloading({ handlers, model, paused }: ModelPartProps) {
  return (
    <ModelSection className="gap-3">
      <ModelBar
        className="gap-y-3"
        tone={paused ? "paused" : "active"}
        value={model.percent}
      >
        <div className="flex w-full items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <ProgressLabel className="font-semibold">
              {model.downloadingTitle}
            </ProgressLabel>
            <p className="text-muted-foreground text-sm">{model.timeLeft}</p>
          </div>
          <ProgressValue className="text-xl font-medium" />
        </div>
      </ModelBar>
      <ModelBarCaption>
        <span>
          {model.downloaded} из {model.size}
          {paused ? null : `, ${model.speed}`}
        </span>
        <span className="flex gap-1">
          {paused ? (
            <Button
              className="h-7 px-3"
              onClick={handlers.onResume}
              variant="secondary"
            >
              Продолжить
            </Button>
          ) : (
            <Button
              className="h-7 px-3"
              onClick={handlers.onPause}
              variant="secondary"
            >
              Пауза
            </Button>
          )}
          <Button
            className="h-7 px-3"
            onClick={handlers.onCancel}
            variant="ghost"
          >
            Отменить
          </Button>
        </span>
      </ModelBarCaption>
      <StepNote className="pt-1" icon={<InfoIcon />}>
        Можно идти дальше, модель докачается сама
      </StepNote>
    </ModelSection>
  );
}

function ModelChecking({ model }: ModelPartProps) {
  const { checking } = model;
  return (
    <ModelSection className="gap-3">
      <ModelBar className="gap-y-3" tone="paused" value={100}>
        <div className="flex w-full items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <ProgressLabel className="font-semibold">
              {checking.title}
            </ProgressLabel>
            <p className="text-muted-foreground text-sm">
              {checking.description}
            </p>
          </div>
          <Spinner className="mb-1 size-5" />
        </div>
      </ModelBar>
      {checking.caption ? (
        <p className="text-muted-foreground font-mono text-xs">
          {checking.caption}
        </p>
      ) : null}
    </ModelSection>
  );
}

function ModelReady({ handlers, model }: ModelPartProps) {
  return (
    <ModelSection className="gap-4">
      <ModelRow
        description={
          model.readyNote ?? `${model.languageName}, ${model.size} на диске`
        }
        icon={<CheckIcon strokeWidth={1.5} />}
        title="Модель готова"
        tone="confirmed"
      />
      <MicCheck
        listening={model.micListening}
        note={model.micNote}
        onAgain={handlers.onMicCheckAgain}
        transcript={model.transcript}
      />
    </ModelSection>
  );
}

/*
 * The hardware check failed. The model can still be used: the step can be
 * left, the live transcript will just lag (or the model be wrong).
 */
function ModelCheckFailed({ handlers, model }: ModelPartProps) {
  const failure = model.checkFailure;
  if (!failure) {
    return null;
  }
  return (
    <ModelSection>
      <ModelRow
        align="start"
        description={failure.description}
        icon={<InfoIcon />}
        title={failure.title}
        tone="contradiction"
      />
      <div className="flex gap-2 pt-1 pl-12">
        {failure.fallback ? (
          <Button className="h-9 px-4" onClick={handlers.onDownloadFallback}>
            <DownloadIcon className="size-3.5" />
            {failure.fallback}
          </Button>
        ) : null}
        {failure.redownload ? (
          <Button className="h-9 px-4" onClick={handlers.onRedownload}>
            Скачать заново
          </Button>
        ) : null}
        <Button
          className="h-9 px-4"
          onClick={handlers.onRecheck}
          variant="secondary"
        >
          Проверить снова
        </Button>
      </div>
    </ModelSection>
  );
}

function ModelError({ handlers, model }: ModelPartProps) {
  const error = model.error ?? {
    description: "Попробуйте скачать ещё раз",
    title: "Не получилось скачать модель",
  };
  return (
    <ModelSection>
      <ModelRow
        align="start"
        description={error.description}
        icon={<CrossIcon />}
        title={error.title}
        tone="contradiction"
      />
      <div className="flex gap-2 pt-1 pl-12">
        <Button className="h-9 px-4" onClick={handlers.onRedownload}>
          Скачать заново
        </Button>
      </div>
    </ModelSection>
  );
}

function ModelNoSpace({ handlers, model }: ModelPartProps) {
  const { disk } = model;
  return (
    <ModelSection>
      <ModelRow
        align="start"
        description={`Для модели нужно ${disk.need}, а свободно только ${disk.free}. Очистите корзину или удалите старые загрузки, потом нажмите «Повторить».`}
        icon={<DiskIcon />}
        title="Не хватает места на диске"
        tone="contradiction"
      />
      <div className="flex flex-col gap-1.5 pl-12">
        <ModelBar
          aria-label={disk.percentLabel}
          color="contradiction"
          value={disk.percent}
        />
        <ModelBarCaption>
          <span>{disk.caption}</span>
          <span className="text-contradiction">не хватает {disk.missing}</span>
        </ModelBarCaption>
      </div>
      <div className="flex gap-2 pt-1 pl-12">
        <Button className="h-9 px-4" onClick={handlers.onRetry}>
          Повторить
        </Button>
        <Button
          className="h-9 px-4"
          onClick={handlers.onOpenStorage}
          variant="secondary"
        >
          Открыть «Хранилище»
        </Button>
      </div>
    </ModelSection>
  );
}

function ModelNoNetwork({ handlers, model }: ModelPartProps) {
  const { interrupted } = model;
  return (
    <ModelSection>
      <ModelRow
        align="start"
        description="Пропал интернет. Скачанное не потеряется, продолжим с того места."
        icon={<WifiOffIcon />}
        title={`Загрузка прервалась на ${interrupted.percent}%`}
        tone="contradiction"
      />
      <div className="flex flex-col gap-1.5 pl-12">
        <ModelBar
          aria-label="Скачано"
          tone="paused"
          value={interrupted.percent}
        />
        <ModelBarCaption>
          <span>
            {interrupted.downloaded} из {model.size}
          </span>
          <span>сами попробуем снова через {interrupted.retryIn}</span>
        </ModelBarCaption>
      </div>
      <div className="flex gap-2 pt-1 pl-12">
        <Button className="h-9 px-4" onClick={handlers.onRetry}>
          Повторить сейчас
        </Button>
      </div>
    </ModelSection>
  );
}

const MODEL_PART = {
  "check-failed": ModelCheckFailed,
  checking: ModelChecking,
  downloading: ModelDownloading,
  error: ModelError,
  language: ModelOffer,
  "no-network": ModelNoNetwork,
  "no-space": ModelNoSpace,
  ready: ModelReady,
} as const;

const NO_HANDLERS: SpeechModelHandlers = {};

export function SpeechModelScreen({
  backHref,
  className,
  handlers = NO_HANDLERS,
  language = "ru",
  languages = SPEECH_LANGUAGES,
  model = SPEECH_MODEL,
  nextHref,
  paused = false,
  state = "language",
}: {
  backHref?: string;
  className?: string;
  handlers?: SpeechModelHandlers;
  /** Id of the selected language. */
  language?: string;
  languages?: readonly SpeechLanguage[];
  model?: SpeechModelInfo;
  nextHref?: string;
  /** The download is on pause ("downloading" state only). */
  paused?: boolean;
  state?: SpeechModelState;
}) {
  const busy = state === "downloading" || state === "checking";
  // The model downloads in the background, so the step can be left as soon
  // as the download has started. A failed check doesn't forbid the model.
  const canContinue = busy || state === "ready" || state === "check-failed";
  const ModelPart = MODEL_PART[state];

  return (
    <OnboardingWindow className={className} step="speech">
      <OnboardingContent>
        <StepHeading
          description="Скачаем модель, которая превращает голос в текст прямо на компьютере. Звонки никуда не отправляются."
          title="Распознавание речи"
        />
        <LanguagePicker
          hint={busy ? "Язык можно сменить после загрузки" : undefined}
          languages={languages}
          muted={busy}
          onValueChange={handlers.onLanguageChange}
          value={language}
        />
        <ModelPart handlers={handlers} model={model} paused={paused} />
      </OnboardingContent>
      <OnboardingFooter
        end={<StepNextButton disabled={!canContinue} href={nextHref} />}
        start={<StepBackButton href={backHref} />}
      />
    </OnboardingWindow>
  );
}
