import { Button } from "@/components/ui/button";
import { ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckIcon,
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
 * - checking: verifying the checksum after the download
 * - ready: model on disk, a live mic check
 * - no-space / no-network: the download stopped, how to fix it
 *
 * The app passes `handlers` and `paused` (a paused download is the
 * downloading state with "Продолжить" instead of "Пауза").
 */
export type SpeechModelState =
  | "language"
  | "downloading"
  | "checking"
  | "ready"
  | "no-space"
  | "no-network";

export interface SpeechModelHandlers {
  onCancel?: () => void;
  onDownload?: () => void;
  onLanguageChange?: (language: string) => void;
  onOpenStorage?: () => void;
  onPause?: () => void;
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
        description={`${model.size}, на диске свободно ${model.freeSpace}`}
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
  return (
    <ModelSection className="gap-3">
      <ModelBar className="gap-y-3" tone="paused" value={100}>
        <div className="flex w-full items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <ProgressLabel className="font-semibold">
              Проверяем модель
            </ProgressLabel>
            <p className="text-muted-foreground text-sm">
              Убеждаемся, что файл скачался целиком, это несколько секунд
            </p>
          </div>
          <Spinner className="mb-1 size-5" />
        </div>
      </ModelBar>
      <p className="text-muted-foreground font-mono text-xs">
        {model.size} из {model.size}
      </p>
    </ModelSection>
  );
}

function ModelReady({ model }: ModelPartProps) {
  return (
    <ModelSection className="gap-4">
      <ModelRow
        description={`${model.languageName}, ${model.size} на диске`}
        icon={<CheckIcon strokeWidth={1.5} />}
        title="Модель готова"
        tone="confirmed"
      />
      <MicCheck transcript={model.transcript} />
    </ModelSection>
  );
}

function ModelNoSpace({ handlers, model }: ModelPartProps) {
  const { disk } = model;
  return (
    <ModelSection>
      <ModelRow
        align="start"
        description={`Для модели нужно ${model.size}, а свободно только ${disk.free}. Очистите корзину или удалите старые загрузки, потом нажмите «Повторить».`}
        icon={<DiskIcon />}
        title="Не хватает места на диске"
        tone="contradiction"
      />
      <div className="flex flex-col gap-1.5 pl-12">
        <ModelBar
          aria-label="Занято на диске"
          color="contradiction"
          value={disk.usedPercent}
        />
        <ModelBarCaption>
          <span>
            {disk.name}, занято {disk.used} из {disk.total}
          </span>
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
  checking: ModelChecking,
  downloading: ModelDownloading,
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
  // as the download has started
  const canContinue = busy || state === "ready";
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
