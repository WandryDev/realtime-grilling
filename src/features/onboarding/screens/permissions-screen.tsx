import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AudioLevelMeter } from "../components/audio-level-meter";
import {
  MicrophoneIcon,
  ScreenAudioIcon,
  SpeakerIcon,
} from "../components/icons";
import { MacPermissionPrompt } from "../components/macos-permission-prompt";
import { OnboardingFooterHint } from "../components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "../components/onboarding-window";
import {
  PermissionList,
  PermissionRow,
  PermissionStatus,
} from "../components/permission-row";
import { ScreenAccessGuide } from "../components/screen-access-guide";
import { StepHeading } from "../components/step-heading";
import { StepBackButton, StepNextButton } from "../components/step-links";
import { StepNote } from "../components/step-note";
import { SOUND_LEVELS } from "../mock";

/*
 * 02 Разрешения.
 * - idle: nothing asked yet, "Разрешить" on both rows
 * - prompt: the macOS dialog for the microphone is open over the window
 * - granted: both allowed, the step can be finished
 * - denied: screen recording was refused, the three-step guide
 * - unknown: macOS doesn't tell about the screen audio, its meter checks it
 * - windows: only the microphone is asked, system sound comes via loopback
 *
 * The app drives the two accesses separately (`microphone`, `screenAudio`)
 * and wires the handlers; previews pass a `state` only. The screen audio
 * access can be `unknown` (macOS doesn't tell): "Разрешить" stays, and the
 * system sound meter shows whether Grill hears the other apps.
 */
export type PermissionsState =
  | "idle"
  | "prompt"
  | "granted"
  | "denied"
  | "unknown"
  | "windows";

export type AccessState = "idle" | "asking" | "granted" | "denied" | "unknown";

/** Why a level meter can't run. */
export type LevelProblem = "noAccess" | "noDevice" | "busy" | "failed";

/** A live level meter: bars, or the reason it can't run. */
export interface LevelReading {
  active: number;
  levels: readonly number[];
  problem?: LevelProblem | null;
}

const PROBLEMS: Record<
  "microphone" | "system",
  Record<LevelProblem, { description: string; short: string }>
> = {
  microphone: {
    busy: {
      description: "Его занимает другое приложение. Закройте его и вернитесь",
      short: "Микрофон занят",
    },
    failed: {
      description: "Проверьте микрофон в настройках системы",
      short: "Не включился",
    },
    noAccess: {
      description: "Включите доступ к микрофону в настройках",
      short: "Нет доступа",
    },
    noDevice: {
      description: "Подключите микрофон или наушники с микрофоном",
      short: "Нет микрофона",
    },
  },
  system: {
    busy: {
      description: "Звук занимает другое приложение. Закройте его и вернитесь",
      short: "Звук занят",
    },
    failed: {
      description: "Проверьте колонки или наушники в настройках системы",
      short: "Не включился",
    },
    noAccess: {
      description:
        "Включите доступ «Запись экрана и системного аудио» в настройках",
      short: "Нет доступа",
    },
    noDevice: {
      description: "Не нашли колонки или наушники",
      short: "Нет устройства",
    },
  },
};

const HEADINGS: Record<
  PermissionsState | "microphone-denied",
  { description: string; title: string }
> = {
  denied: {
    description: "Без него Grill услышит только вас, а клиента нет.",
    title: "Нужен доступ к звуку звонка",
  },
  granted: {
    description:
      "Grill будет слышать и вас, и клиента. Запись включается только во время звонка, когда вы нажмёте «Начать».",
    title: "Всё разрешено",
  },
  idle: {
    description:
      "macOS спросит разрешение два раза. Без них Grill не услышит ни вас, ни клиента.",
    title: "Разрешите Grill слышать звонок",
  },
  "microphone-denied": {
    description: "Без него Grill не услышит вас, а значит не поймёт разговор.",
    title: "Нужен доступ к микрофону",
  },
  prompt: {
    description:
      "macOS спросит разрешение два раза. Без них Grill не услышит ни вас, ни клиента.",
    title: "Разрешите Grill слышать звонок",
  },
  unknown: {
    description:
      "macOS не говорит, включён ли доступ к звуку звонка. Проверим по звуку: включите любое видео.",
    title: "Проверим звук звонка",
  },
  windows: {
    description:
      "Windows спросит только про микрофон. Голос клиента Grill возьмёт из звука колонок или наушников.",
    title: "Микрофон и звук звонка",
  },
};

const DENIED_STEPS = [
  "Нажмите «Открыть настройки», нужный раздел откроется сам",
  "Включите переключатель рядом с Grill",
  "macOS предложит перезапустить Grill, согласитесь. Мы вернём вас на этот шаг",
] as const;

const MICROPHONE = {
  description: "Чтобы слышать вас",
  title: "Микрофон",
};

const SCREEN_AUDIO = {
  description:
    "Чтобы слышать клиента в Zoom, Meet или Telegram. Экран Grill не записывает, только звук.",
  title: "Запись экрана и системного звука",
};

/** The two accesses each preview state stands for. */
const ACCESS: Record<
  PermissionsState,
  { microphone: AccessState; screenAudio: AccessState }
> = {
  denied: { microphone: "granted", screenAudio: "denied" },
  granted: { microphone: "granted", screenAudio: "granted" },
  idle: { microphone: "idle", screenAudio: "idle" },
  prompt: { microphone: "asking", screenAudio: "idle" },
  unknown: { microphone: "granted", screenAudio: "unknown" },
  windows: { microphone: "granted", screenAudio: "idle" },
};

export interface PermissionsHandlers {
  onAnswerMicrophone?: (allowed: boolean) => void;
  onAnswerScreenAudio?: (allowed: boolean) => void;
  onOpenSettings?: () => void;
  onRecheck?: () => void;
  onRequestMicrophone?: () => void;
  onRequestScreenAudio?: () => void;
  /** macOS applied the screen audio access only after a restart. */
  onRestart?: () => void;
}

const RESTART_HINT =
  "Если вы уже разрешили доступ, перезапустите Grill: macOS применит его только после перезапуска.";

function AccessStatus({
  access,
  onRequest,
  primary,
}: {
  access: AccessState;
  onRequest?: () => void;
  primary: boolean;
}) {
  if (access === "asking") {
    return <PermissionStatus state="waiting" />;
  }
  if (access === "granted" || access === "denied") {
    return <PermissionStatus state={access} />;
  }
  // `idle` and `unknown`: asking again is harmless
  return (
    <Button onClick={onRequest} variant={primary ? "default" : "secondary"}>
      Разрешить
    </Button>
  );
}

function PermissionRows({
  handlers,
  messages,
  microphone,
  restartNeeded,
  screenAudio,
  windows,
}: {
  handlers: PermissionsHandlers;
  messages: AccessMessages;
  microphone: AccessState;
  restartNeeded: boolean;
  screenAudio: AccessState;
  windows: boolean;
}) {
  return (
    <PermissionList>
      <PermissionRow
        description={messages.microphone ?? MICROPHONE.description}
        icon={<MicrophoneIcon />}
        status={
          <AccessStatus
            access={microphone}
            onRequest={handlers.onRequestMicrophone}
            primary
          />
        }
        title={MICROPHONE.title}
      />
      {windows ? (
        <PermissionRow
          description="Отдельное разрешение не нужно. Grill слышит то же, что и вы в наушниках, записи экрана нет."
          icon={<SpeakerIcon />}
          status={
            <span className="text-muted-foreground flex h-8 items-center text-sm">
              Проверим ниже
            </span>
          }
          title="Системный звук"
        />
      ) : (
        <PermissionRow
          description={
            restartNeeded
              ? RESTART_HINT
              : (messages.screenAudio ?? SCREEN_AUDIO.description)
          }
          icon={<ScreenAudioIcon />}
          status={
            restartNeeded ? (
              <Button onClick={handlers.onRestart} variant="secondary">
                Перезапустить
              </Button>
            ) : (
              <AccessStatus
                access={screenAudio}
                onRequest={handlers.onRequestScreenAudio}
                // The next thing to press once the microphone is allowed
                primary={microphone === "granted"}
              />
            )
          }
          title={SCREEN_AUDIO.title}
        />
      )}
    </PermissionList>
  );
}

/** Shown instead of the row descriptions, e.g. "нужна macOS 14.2". */
interface AccessMessages {
  microphone?: string | null;
  screenAudio?: string | null;
}

/**
 * A live level meter in a gray card: the system sound or the microphone.
 * When the source can't be opened, the reason replaces the bars.
 */
function LevelCheck({
  description,
  label,
  reading,
  source,
  title,
}: {
  description: string;
  label?: string;
  reading: LevelReading;
  source: "microphone" | "system";
  title: string;
}) {
  const problem = reading.problem ? PROBLEMS[source][reading.problem] : null;
  return (
    <Alert className="gap-x-3.5 px-4">
      <AlertTitle className="text-sm font-semibold">{title}</AlertTitle>
      <AlertDescription>{problem?.description ?? description}</AlertDescription>
      <AlertAction>
        {problem ? (
          <span className="text-destructive flex h-6 items-center text-sm font-medium">
            {problem.short}
          </span>
        ) : (
          <AudioLevelMeter
            active={reading.active}
            label={label}
            levels={reading.levels}
          />
        )}
      </AlertAction>
    </Alert>
  );
}

/** Windows: the microphone is off in the privacy settings. */
function WindowsMicrophoneHint({
  checking,
  handlers,
}: {
  checking: boolean;
  handlers: PermissionsHandlers;
}) {
  return (
    <Alert className="gap-x-3.5 px-4" variant="warning">
      <AlertTitle className="text-sm font-semibold">
        Микрофон выключен в параметрах Windows
      </AlertTitle>
      <AlertDescription>
        Включите «Доступ к микрофону» для классических приложений и нажмите
        «Проверить»
      </AlertDescription>
      <AlertAction className="flex gap-2">
        <Button onClick={handlers.onOpenSettings} size="sm">
          Открыть параметры
        </Button>
        <Button
          loading={checking}
          onClick={handlers.onRecheck}
          size="sm"
          variant="secondary"
        >
          Проверить
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Silence while another app plays: the screen audio access is missing. */
function SilentSystemHint({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <Alert className="gap-x-3.5 px-4" variant="warning">
      <AlertTitle className="text-sm font-semibold">
        Не слышим звук других приложений
      </AlertTitle>
      <AlertDescription>
        Проверьте доступ «Запись экрана и системного аудио» в настройках
      </AlertDescription>
      <AlertAction>
        <Button onClick={onOpenSettings} size="sm" variant="secondary">
          Открыть настройки
        </Button>
      </AlertAction>
    </Alert>
  );
}

function AccessPrompt({
  description,
  onAnswer,
  title,
}: {
  description: string;
  onAnswer?: (allowed: boolean) => void;
  title: string;
}) {
  const allow = onAnswer ? () => onAnswer(true) : undefined;
  const deny = onAnswer ? () => onAnswer(false) : undefined;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-[150px]">
      <MacPermissionPrompt
        className="pointer-events-auto"
        description={description}
        onAllow={allow}
        onDeny={deny}
        title={title}
      />
    </div>
  );
}

function headingKey(
  windows: boolean,
  microphone: AccessState,
  screenAudio: AccessState
): keyof typeof HEADINGS {
  if (windows) {
    return "windows";
  }
  if (microphone === "denied") {
    return "microphone-denied";
  }
  if (screenAudio === "denied") {
    return "denied";
  }
  if (microphone === "granted" && screenAudio === "granted") {
    return "granted";
  }
  if (microphone === "granted" && screenAudio === "unknown") {
    return "unknown";
  }
  return "idle";
}

function DeniedGuide({
  checking,
  handlers,
}: {
  checking: boolean;
  handlers: PermissionsHandlers;
}) {
  return (
    <ScreenAccessGuide
      actions={
        <>
          <Button onClick={handlers.onOpenSettings}>Открыть настройки</Button>
          <Button
            className="bg-background hover:bg-background/70"
            loading={checking}
            onClick={handlers.onRecheck}
            variant="secondary"
          >
            Проверить
          </Button>
        </>
      }
      steps={DENIED_STEPS}
    />
  );
}

/** The fake macOS dialog over the window while an access is asked. */
function SystemPromptOverlay({
  handlers,
  microphone,
  screenAudio,
}: {
  handlers: PermissionsHandlers;
  microphone: AccessState;
  screenAudio: AccessState;
}) {
  if (microphone === "asking") {
    return (
      <AccessPrompt
        description="Grill слушает вас во время звонков, чтобы расшифровывать разговор."
        onAnswer={handlers.onAnswerMicrophone}
        title="Программа «Grill» запрашивает доступ к микрофону."
      />
    );
  }
  if (screenAudio === "asking") {
    return (
      <AccessPrompt
        description="Grill записывает только звук звонка, чтобы слышать клиента. Экран не записывается."
        onAnswer={handlers.onAnswerScreenAudio}
        title="Программа «Grill» запрашивает доступ к записи экрана и системного звука."
      />
    );
  }
  return null;
}

/**
 * Under the rows: how to turn a refused access on, or a live meter to
 * check what Grill hears.
 */
function StepExtra({
  checking,
  handlers,
  microphone,
  microphoneLevel,
  screenAudio,
  silentSystemAudio,
  sound,
  systemLevel,
  windows,
}: {
  checking: boolean;
  handlers: PermissionsHandlers;
  microphone: AccessState;
  microphoneLevel?: LevelReading;
  screenAudio: AccessState;
  silentSystemAudio: boolean;
  sound: LevelReading;
  systemLevel?: LevelReading;
  windows: boolean;
}) {
  if (windows) {
    return microphone === "denied" ? (
      <WindowsMicrophoneHint checking={checking} handlers={handlers} />
    ) : (
      <LevelCheck
        description="Включите любое видео, полоска справа оживёт"
        reading={sound}
        source="system"
        title="Проверим звук"
      />
    );
  }
  if (microphone === "denied" || screenAudio === "denied") {
    return <DeniedGuide checking={checking} handlers={handlers} />;
  }
  if (screenAudio === "unknown" && silentSystemAudio) {
    return <SilentSystemHint onOpenSettings={handlers.onOpenSettings} />;
  }
  if (screenAudio === "unknown" && systemLevel) {
    return (
      <LevelCheck
        description="Включите любое видео, полоска справа оживёт"
        reading={systemLevel}
        source="system"
        title="Проверим звук"
      />
    );
  }
  if (microphone === "granted" && microphoneLevel) {
    return (
      <LevelCheck
        description="Скажите что-нибудь, полоска справа оживёт"
        label="Уровень микрофона"
        reading={microphoneLevel}
        source="microphone"
        title="Проверим микрофон"
      />
    );
  }
  return null;
}

const NO_HANDLERS: PermissionsHandlers = {};
const NO_MESSAGES: AccessMessages = {};

export function PermissionsScreen({
  backHref,
  checking = false,
  className,
  drawSystemPrompt = true,
  handlers = NO_HANDLERS,
  messages = NO_MESSAGES,
  microphone: microphoneProp,
  microphoneLevel,
  nextHref,
  restartNeeded = false,
  screenAudio: screenAudioProp,
  silentSystemAudio = false,
  soundLevels = SOUND_LEVELS,
  soundActive = 5,
  soundProblem,
  state = "idle",
  systemLevel,
}: {
  backHref?: string;
  /** "Проверить" is re-reading the accesses. */
  checking?: boolean;
  className?: string;
  /**
   * Draws the macOS dialog over the window while asking (the Paper frames
   * and the browser mock). In the app macOS shows its own.
   */
  drawSystemPrompt?: boolean;
  handlers?: PermissionsHandlers;
  /** From the OS side, shown instead of the row descriptions. */
  messages?: AccessMessages;
  /** Overrides the microphone access implied by `state`. */
  microphone?: AccessState;
  /**
   * macOS: once the microphone is allowed, a live meter to check it. Shown
   * only when passed (the app), the Paper frames don't have it.
   */
  microphoneLevel?: LevelReading;
  nextHref?: string;
  /**
   * macOS: the screen audio prompt was answered but this process still
   * reads "not asked"; the access shows up after a restart.
   */
  restartNeeded?: boolean;
  /** Overrides the screen recording access implied by `state`. */
  screenAudio?: AccessState;
  /**
   * macOS, screen audio `unknown`: the system sound stayed silent while
   * another app played, so the access is likely off.
   */
  silentSystemAudio?: boolean;
  /** Windows: how many bars of the system sound meter are lit. */
  soundActive?: number;
  /** Windows: bar heights of the live system sound meter. */
  soundLevels?: readonly number[];
  /** Windows: the system sound can't be opened. */
  soundProblem?: LevelProblem | null;
  state?: PermissionsState;
  /** macOS, screen audio `unknown`: the live system sound meter. */
  systemLevel?: LevelReading;
}) {
  const windows = state === "windows";
  const microphone = microphoneProp ?? ACCESS[state].microphone;
  const screenAudio = screenAudioProp ?? ACCESS[state].screenAudio;
  const heading = HEADINGS[headingKey(windows, microphone, screenAudio)];
  const asking = microphone === "asking" || screenAudio === "asking";
  const denied = microphone === "denied" || screenAudio === "denied";
  const canContinue = windows
    ? microphone === "granted"
    : microphone === "granted" &&
      (screenAudio === "granted" || screenAudio === "unknown");

  const overlay = drawSystemPrompt ? (
    <SystemPromptOverlay
      handlers={handlers}
      microphone={microphone}
      screenAudio={screenAudio}
    />
  ) : null;

  const extra = (
    <StepExtra
      checking={checking}
      handlers={handlers}
      microphone={microphone}
      microphoneLevel={microphoneLevel}
      screenAudio={screenAudio}
      silentSystemAudio={silentSystemAudio}
      sound={{
        active: soundActive,
        levels: soundLevels,
        problem: soundProblem,
      }}
      systemLevel={systemLevel}
      windows={windows}
    />
  );

  const rows = (
    <PermissionRows
      handlers={handlers}
      messages={messages}
      microphone={microphone}
      restartNeeded={restartNeeded && !windows}
      screenAudio={screenAudio}
      windows={windows}
    />
  );

  return (
    <OnboardingWindow
      className={className}
      overlay={overlay}
      platform={windows ? "windows" : "macos"}
      step="permissions"
    >
      <OnboardingContent className={denied ? "gap-6" : undefined}>
        <StepHeading description={heading.description} title={heading.title} />
        {asking ? (
          <div className="flex flex-col gap-4">
            {rows}
            <StepNote dot>
              Нажмите «Разрешить» в окошке macOS над этим окном
            </StepNote>
          </div>
        ) : (
          rows
        )}
        {extra}
      </OnboardingContent>
      <OnboardingFooter
        end={
          <>
            {canContinue || asking || denied ? null : (
              <OnboardingFooterHint>
                Сначала разрешите оба доступа
              </OnboardingFooterHint>
            )}
            <StepNextButton disabled={!canContinue} href={nextHref} />
          </>
        }
        start={<StepBackButton href={backHref} />}
      />
    </OnboardingWindow>
  );
}
