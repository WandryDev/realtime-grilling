import {
  OnboardingBackButton,
  OnboardingNextButton,
} from "@/features/onboarding/components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "@/features/onboarding/components/onboarding-window";
import { StepHeading } from "@/features/onboarding/components/step-heading";
import { linkButtonProps } from "@/features/onboarding/integrations/link-button";
import {
  SETUP_SUMMARY_INTEGRATIONS,
  SETUP_SUMMARY_REQUIRED,
  type SetupSummaryItem,
} from "@/features/onboarding/integrations/mock";
import { SetupSummary } from "@/features/onboarding/integrations/setup-summary";

/*
 * Paper "06 Готово": what was set up. Required steps are always checked,
 * skipped integrations are gray with "Подключить". "Добавить первый проект"
 * closes the wizard and opens the new project flow.
 */
export function DoneScreen({
  backHref,
  className,
  connectHref,
  integrations = SETUP_SUMMARY_INTEGRATIONS,
  onFinish,
  required = SETUP_SUMMARY_REQUIRED,
}: {
  backHref?: string;
  className?: string;
  /** Where "Подключить" of a skipped integration leads. */
  connectHref?: (item: SetupSummaryItem) => string | undefined;
  integrations?: SetupSummaryItem[];
  /** "Добавить первый проект". */
  onFinish?: () => void;
  required?: SetupSummaryItem[];
}) {
  return (
    <OnboardingWindow className={className} step="done">
      <OnboardingContent className="gap-7">
        <StepHeading
          description="Осталось добавить проект и людей со стороны клиента. Пропущенное можно настроить потом."
          title="Grill готов к первому звонку"
        />
        <SetupSummary
          connectHref={connectHref}
          groups={[required, integrations]}
        />
      </OnboardingContent>
      <OnboardingFooter
        end={
          <OnboardingNextButton onClick={onFinish}>
            Добавить первый проект
          </OnboardingNextButton>
        }
        start={<OnboardingBackButton {...linkButtonProps(backHref)} />}
      />
    </OnboardingWindow>
  );
}
