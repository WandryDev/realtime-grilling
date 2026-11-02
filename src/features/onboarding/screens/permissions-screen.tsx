import type { ReactNode } from "react";

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
 * - windows: only the microphone is asked, system sound comes via loopback
 *
 * The app drives the two accesses separately (`microphone`, `screenAudio`)
 * and wires the handlers; previews pass a `state` only.
 */
export type PermissionsState =
  | "idle"
  | "prompt"
  | "granted"
  | "denied"
  | "windows";

export type AccessState = "idle" | "asking" | "granted" | "denied";

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
  windows: { microphone: "granted", screenAudio: "idle" },
};

export interface PermissionsHandlers {
  onAnswerMicrophone?: (allowed: boolean) => void;
  onAnswerScreenAudio?: (allowed: boolean) => void;
  onOpenSettings?: () => void;
  onRecheck?: () => void;
  onRequestMicrophone?: () => void;
  onRequestScreenAudio?: () => void;
}

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
  return (
    <Button onClick={onRequest} variant={primary ? "default" : "secondary"}>
      Разрешить
    </Button>
  );
}

function PermissionRows({
  handlers,
  microphone,
  screenAudio,
  windows,
}: {
  handlers: PermissionsHandlers;
  microphone: AccessState;
  screenAudio: AccessState;
  windows: boolean;
}) {
  return (
    <PermissionList>
      <PermissionRow
        description={MICROPHONE.description}
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
          description={SCREEN_AUDIO.description}
          icon={<ScreenAudioIcon />}
          status={
            <AccessStatus
              access={screenAudio}
              onRequest={handlers.onRequestScreenAudio}
              // The next thing to press once the microphone is allowed
              primary={microphone === "granted"}
            />
          }
          title={SCREEN_AUDIO.title}
        />
      )}
    </PermissionList>
  );
}

/** A live level meter in a gray card: the system sound or the microphone. */
function LevelCheck({
  active,
  description,
  label,
  levels,
  title,
}: {
  active: number;
  description: string;
  label?: string;
  levels: readonly number[];
  title: string;
}) {
  return (
    <Alert className="gap-x-3.5 px-4">
      <AlertTitle className="text-sm font-semibold">{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertAction>
        <AudioLevelMeter active={active} label={label} levels={levels} />
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

const NO_HANDLERS: PermissionsHandlers = {};

export function PermissionsScreen({
  backHref,
  checking = false,
  className,
  handlers = NO_HANDLERS,
  microphone: microphoneProp,
  microphoneLevel,
  nextHref,
  screenAudio: screenAudioProp,
  soundLevels = SOUND_LEVELS,
  soundActive = 5,
  state = "idle",
}: {
  backHref?: string;
  /** "Проверить" is re-reading the accesses. */
  checking?: boolean;
  className?: string;
  handlers?: PermissionsHandlers;
  /** Overrides the microphone access implied by `state`. */
  microphone?: AccessState;
  /**
   * macOS: once the microphone is allowed, a live meter to check it. Shown
   * only when passed (the app), the Paper frames don't have it.
   */
  microphoneLevel?: { active: number; levels: readonly number[] };
  nextHref?: string;
  /** Overrides the screen recording access implied by `state`. */
  screenAudio?: AccessState;
  /** Windows: how many bars of the system sound meter are lit. */
  soundActive?: number;
  /** Windows: bar heights of the live system sound meter. */
  soundLevels?: readonly number[];
  state?: PermissionsState;
}) {
  const windows = state === "windows";
  const microphone = microphoneProp ?? ACCESS[state].microphone;
  const screenAudio = screenAudioProp ?? ACCESS[state].screenAudio;
  const heading = HEADINGS[headingKey(windows, microphone, screenAudio)];
  const asking = microphone === "asking" || screenAudio === "asking";
  const denied = microphone === "denied" || screenAudio === "denied";
  const canContinue = windows
    ? microphone === "granted"
    : microphone === "granted" && screenAudio === "granted";

  let overlay: ReactNode = null;
  if (microphone === "asking") {
    overlay = (
      <AccessPrompt
        description="Grill слушает вас во время звонков, чтобы расшифровывать разговор."
        onAnswer={handlers.onAnswerMicrophone}
        title="Программа «Grill» запрашивает доступ к микрофону."
      />
    );
  } else if (screenAudio === "asking") {
    overlay = (
      <AccessPrompt
        description="Grill записывает только звук звонка, чтобы слышать клиента. Экран не записывается."
        onAnswer={handlers.onAnswerScreenAudio}
        title="Программа «Grill» запрашивает доступ к записи экрана и системного звука."
      />
    );
  }

  let extra: ReactNode = null;
  if (denied && !windows) {
    extra = <DeniedGuide checking={checking} handlers={handlers} />;
  } else if (windows) {
    extra = (
      <LevelCheck
        active={soundActive}
        description="Включите любое видео, полоска справа оживёт"
        levels={soundLevels}
        title="Проверим звук"
      />
    );
  } else if (microphoneLevel && microphone === "granted") {
    extra = (
      <LevelCheck
        active={microphoneLevel.active}
        description="Скажите что-нибудь, полоска справа оживёт"
        label="Уровень микрофона"
        levels={microphoneLevel.levels}
        title="Проверим микрофон"
      />
    );
  }

  const rows = (
    <PermissionRows
      handlers={handlers}
      microphone={microphone}
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
