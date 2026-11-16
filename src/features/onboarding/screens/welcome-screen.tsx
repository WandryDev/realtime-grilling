import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { GrillAppIcon } from "../components/grill-app-icon";
import { IconTile } from "../components/icon-tile";
import {
  LockIcon,
  MicrophoneIcon,
  NotesIcon,
  QuestionCircleIcon,
} from "../components/icons";
import { OnboardingFooterHint } from "../components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "../components/onboarding-window";
import { StepHeading } from "../components/step-heading";
import { StepNextButton } from "../components/step-links";
import { WELCOME_FEATURES, type WelcomeFeature } from "../mock";

const FEATURE_ICONS = {
  mic: MicrophoneIcon,
  notes: NotesIcon,
  question: QuestionCircleIcon,
} as const;

/* 01 Приветствие: shown once, on the first launch. */
export function WelcomeScreen({
  className,
  features = WELCOME_FEATURES,
  nextHref,
}: {
  className?: string;
  features?: readonly WelcomeFeature[];
  /** "Начать" leads here; a plain button without it (previews). */
  nextHref?: string;
}) {
  return (
    <OnboardingWindow className={className} step="welcome">
      <OnboardingContent>
        <div className="flex flex-col gap-5">
          <GrillAppIcon />
          <StepHeading
            description="Помощник для звонков с клиентами. Настроим всё без терминала и технических знаний."
            size="hero"
            title="Здравствуйте, это Grill"
          />
        </div>
        <ul className="flex flex-col gap-4">
          {features.map((feature) => {
            const Icon = FEATURE_ICONS[feature.icon];
            return (
              <li className="flex items-start gap-3.5" key={feature.id}>
                <IconTile size="sm">
                  <Icon strokeWidth={1.5} />
                </IconTile>
                <p className="pt-1 text-base">{feature.text}</p>
              </li>
            );
          })}
        </ul>
        <Alert className="*:[svg]:text-foreground items-start gap-y-0.5 px-4 *:[svg]:mt-0.5">
          <LockIcon strokeWidth={1.5} />
          <AlertTitle>Всё хранится на вашем компьютере</AlertTitle>
          <AlertDescription>
            Записи и расшифровки никуда не загружаются. Агенту уходит только
            текст разговора, чтобы придумать вопросы.
          </AlertDescription>
        </Alert>
      </OnboardingContent>
      <OnboardingFooter
        end={<StepNextButton href={nextHref}>Начать</StepNextButton>}
        start={
          <OnboardingFooterHint className="pr-0">
            Займёт около 5 минут
          </OnboardingFooterHint>
        }
      />
    </OnboardingWindow>
  );
}
