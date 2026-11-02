import { type ComponentProps, type ReactNode, useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IntegrationRow } from "@/components/ui/integration-row";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlusIcon } from "@/features/shell/icons";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ClockIcon, RefreshIcon } from "../icons";
import type {
  BRIEF,
  BRIEF_STATUS,
  CallSummary,
  PersonSummary,
  PROJECT_ANCHORS,
  PROJECT_SOURCES,
} from "../mock";
import { BriefBody } from "./brief-section";
import { CallLineList } from "./call-line";
import { PersonCard } from "./person-card";
import { SectionHeading } from "./section-heading";
import { SourceTile } from "./source-mark";

/*
 * Sections of the project page. Each one after the brief starts with a
 * hairline and 28px of air.
 */

/** Anchors to the sections; they stick to the top on scroll. */
export function ProjectAnchors({
  anchors,
  className,
  onValueChange,
  value = "brief",
}: {
  anchors: typeof PROJECT_ANCHORS;
  className?: string;
  /** Makes the tabs controlled: the page scrolls to the picked section. */
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  return (
    <Tabs
      className={cn("border-border border-b pb-4", className)}
      defaultValue={onValueChange ? undefined : value}
      onValueChange={onValueChange}
      value={onValueChange ? value : undefined}
    >
      <TabsList aria-label="Разделы проекта">
        {anchors.map((anchor) => (
          <TabsTrigger key={anchor.id} value={anchor.id}>
            {anchor.label}
            {anchor.count ? <TabsCount>{anchor.count}</TabsCount> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function ProjectSection({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "border-border flex scroll-mt-20 flex-col border-t pt-7",
        className
      )}
      {...props}
    />
  );
}

export type BriefState = "fresh" | "updating" | "outdated";

export function BriefSection({
  brief,
  className,
  id,
  onRefresh,
  onStop,
  state,
  status,
}: {
  brief: typeof BRIEF;
  className?: string;
  id?: string;
  /** "Обновить" / "Обновить бриф". */
  onRefresh?: () => void;
  /** "Остановить" while updating. */
  onStop?: () => void;
  state: BriefState;
  status: typeof BRIEF_STATUS;
}) {
  const titleId = useId();
  return (
    <section
      aria-busy={state === "updating" || undefined}
      aria-labelledby={titleId}
      className={cn("flex scroll-mt-20 flex-col gap-6", className)}
      id={id}
    >
      <SectionHeading
        action={
          <BriefAction onRefresh={onRefresh} onStop={onStop} state={state} />
        }
        id={titleId}
        meta={<BriefMeta state={state} status={status} />}
        title="Бриф"
      />
      {state === "updating" ? (
        <BriefUpdateBar value={status.updatingProgress} />
      ) : null}
      {state === "outdated" ? (
        <Alert className="items-start gap-y-0.5 *:[svg]:mt-[3px]">
          <ClockIcon />
          <AlertTitle>{status.outdatedNotice.title}</AlertTitle>
          <AlertDescription>{status.outdatedNotice.detail}</AlertDescription>
        </Alert>
      ) : null}
      <BriefBody
        brief={brief}
        className={cn(state === "updating" && "opacity-45")}
      />
    </section>
  );
}

function BriefMeta({
  state,
  status,
}: {
  state: BriefState;
  status: typeof BRIEF_STATUS;
}) {
  if (state === "updating") {
    return (
      <span className="text-foreground flex items-center gap-2">
        <Spinner className="text-accent [&_[data-slot=spinner-track]]:stroke-border" />
        {status.updating}
      </span>
    );
  }
  return state === "outdated" ? status.outdated : status.fresh;
}

function BriefAction({
  onRefresh,
  onStop,
  state,
}: {
  onRefresh?: () => void;
  onStop?: () => void;
  state: BriefState;
}) {
  if (state === "updating") {
    return (
      <Button onClick={onStop} variant="secondary">
        Остановить
      </Button>
    );
  }
  if (state === "outdated") {
    return (
      <Button className="h-9 pr-3.5 pl-3" onClick={onRefresh}>
        <RefreshIcon className="size-3.5" />
        Обновить бриф
      </Button>
    );
  }
  return (
    <Button className="pr-3.5 pl-3" onClick={onRefresh} variant="secondary">
      <RefreshIcon className="size-3.5" />
      Обновить
    </Button>
  );
}

/** Thin orange line of the brief refresh. */
function BriefUpdateBar({ value }: { value: number }) {
  return (
    <Progress
      aria-label="Обновление брифа"
      className="[&_[data-slot=progress-track]]:h-[3px]"
      size="sm"
      tone="active"
      value={value}
    />
  );
}

export function PeopleSection({
  action,
  className,
  id,
  onAdd,
  people,
  projectId = "telemedia",
}: {
  action?: ReactNode;
  className?: string;
  id?: string;
  /** "Добавить": opens "Новый человек". */
  onAdd?: () => void;
  people: PersonSummary[];
  /** Project of the people, for the links to their profiles. */
  projectId?: string;
}) {
  const titleId = useId();
  return (
    <ProjectSection
      aria-labelledby={titleId}
      className={cn("gap-4", className)}
      id={id}
    >
      <SectionHeading
        action={
          action ?? (
            <Button className="pr-3.5 pl-3" onClick={onAdd} variant="secondary">
              <PlusIcon className="size-3.5" />
              Добавить
            </Button>
          )
        }
        id={titleId}
        meta="от профиля зависит, как звучат вопросы"
        title="Люди клиента"
      />
      {people.length > 0 ? (
        <ul className="flex flex-wrap gap-4">
          {people.map((person) => (
            <li className="flex min-w-[320px] flex-1" key={person.id}>
              <PersonCard
                className="flex-1"
                href={routes.person(projectId, person.id)}
                person={person}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          Пока никого. Без профилей агент формулирует вопросы нейтрально.
        </p>
      )}
    </ProjectSection>
  );
}

export function CallsSection({
  calls,
  className,
  hidden,
  id,
  moreHref,
  summary,
}: {
  calls: CallSummary[];
  className?: string;
  /** Calls under "Показать ещё". */
  hidden: number;
  id?: string;
  /** "Показать ещё" leads to the project's history. */
  moreHref?: string;
  summary: string;
}) {
  const titleId = useId();
  return (
    <ProjectSection
      aria-labelledby={titleId}
      className={cn("gap-2", className)}
      id={id}
    >
      <SectionHeading
        className="pb-2"
        id={titleId}
        meta={summary}
        title="Звонки"
      />
      <CallLineList calls={calls} empty="Звонков по проекту ещё не было" />
      {hidden > 0 ? (
        <div className="px-4 pt-1">
          <Button
            className="-mx-2 -my-1.5 px-2"
            {...linkButtonProps(moreHref)}
            size="sm"
            variant="ghost"
          >
            Показать ещё {hidden}
          </Button>
        </div>
      ) : null}
    </ProjectSection>
  );
}

export function SourcesSection({
  className,
  id,
  sources,
}: {
  className?: string;
  id?: string;
  sources: typeof PROJECT_SOURCES;
}) {
  const titleId = useId();
  return (
    <ProjectSection
      aria-labelledby={titleId}
      className={cn("gap-2", className)}
      id={id}
    >
      <SectionHeading
        className="pb-2"
        id={titleId}
        meta="агент только читает"
        title="Источники"
      />
      {sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Источники можно подключить в настройках, в разделе «Интеграции».
        </p>
      ) : null}
      <div className="flex flex-col">
        {sources.map((source) => (
          <IntegrationRow
            action={
              <Button
                className="-mr-2 px-2"
                {...linkButtonProps(routes.settings("integrations"))}
                size="sm"
                variant="ghost"
              >
                Настроить
              </Button>
            }
            className="[&_[data-slot=item-meta]]:text-muted-foreground gap-3.5 px-0 py-3 last:border-b-0 [&_[data-slot=item-actions]]:w-20 [&_[data-slot=item-meta]]:w-50 [&_[data-slot=item-meta]]:gap-1.5"
            description={
              <span className={cn(source.mono && "font-mono text-xs/[18px]")}>
                {source.description}
              </span>
            }
            icon={<SourceTile kind={source.kind} size="lg" />}
            key={source.kind}
            name={source.name}
            status="connected"
            statusLabel={source.status}
          />
        ))}
      </div>
    </ProjectSection>
  );
}
