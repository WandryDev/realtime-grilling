import { Button } from "@/components/ui/button";
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
import {
  SERVICE_NAMES,
  SERVICES_NOTHING_CONNECTED,
  SERVICES_PARTLY_CONNECTED,
  type ServiceId,
  type ServiceListItem,
} from "@/features/onboarding/integrations/mock";
import { ServiceTile } from "@/features/onboarding/integrations/service-logo";
import {
  ServiceList,
  ServiceRow,
} from "@/features/onboarding/integrations/service-row";
import { linkButtonProps } from "@/lib/link-button";

/*
 * Paper "05 Интеграции". GitHub, Outline and ClickUp, all optional. A row
 * opens the service step and shows its status when we come back.
 * - empty: nothing connected, the footer offers "Пропустить"
 * - partial: one connected, one failed, one waiting; "Продолжить"
 * The app passes the hrefs: back to the agent step, each row to its service
 * step, "Пропустить"/"Продолжить" to the summary.
 */
export type IntegrationsScreenState = "empty" | "partial";

const ITEMS: Record<IntegrationsScreenState, ServiceListItem[]> = {
  empty: SERVICES_NOTHING_CONNECTED,
  partial: SERVICES_PARTLY_CONNECTED,
};

export function IntegrationsScreen({
  backHref,
  className,
  items,
  nextHref,
  serviceHref,
  state = "empty",
}: {
  backHref?: string;
  className?: string;
  /** Overrides the rows of the state. */
  items?: ServiceListItem[];
  nextHref?: string;
  serviceHref?: (service: ServiceId) => string;
  state?: IntegrationsScreenState;
}) {
  const rows = items ?? ITEMS[state];
  const touched = rows.some(
    (row) => row.status !== "idle" && row.status !== "soon"
  );

  return (
    <OnboardingWindow className={className} step="integrations">
      <OnboardingContent className="gap-7">
        <StepHeading
          description="Необязательно. С ними Grill прямо во время звонка находит нужное в документации, коде и задачах."
          title="Подключите рабочие сервисы"
        />
        <ServiceList aria-label="Сервисы">
          {rows.map((row) => (
            <ServiceRow
              description={row.description}
              href={row.status === "soon" ? undefined : serviceHref?.(row.id)}
              icon={<ServiceTile service={row.id} />}
              key={row.id}
              name={SERVICE_NAMES[row.id]}
              status={row.status}
            />
          ))}
        </ServiceList>
        <p className="text-muted-foreground -mt-3 text-sm">
          Всё можно подключить позже в настройках. Для каждого проекта потом
          выберете свои репозитории, коллекции и списки задач.
        </p>
      </OnboardingContent>
      <OnboardingFooter
        end={
          touched ? (
            <OnboardingNextButton {...linkButtonProps(nextHref)} />
          ) : (
            <Button {...linkButtonProps(nextHref)} size="lg" variant="ghost">
              Пропустить
            </Button>
          )
        }
        start={<OnboardingBackButton {...linkButtonProps(backHref)} />}
      />
    </OnboardingWindow>
  );
}
