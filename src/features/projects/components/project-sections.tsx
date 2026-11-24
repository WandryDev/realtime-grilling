import { Alert, AlertDescription, AlertTitle } from "@grill/ui/alert";
import { Button } from "@grill/ui/button";
import { IntegrationRow } from "@grill/ui/integration-row";
import { Progress } from "@grill/ui/progress";
import { Spinner } from "@grill/ui/spinner";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@grill/ui/tabs";
import { type ComponentProps, type ReactNode, useId } from "react";
import { PlusIcon } from "@/features/shell/icons";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ClockIcon, RefreshIcon } from "../icons";
import type {
  CallSummary,
  PersonSummary,
  PROJECT_ANCHORS,
  PROJECT_SOURCES,
} from "../mock";
import { BriefBody, type BriefView } from "./brief-section";
import { CallLineList } from "./call-line";
import { PersonCard } from "./person-card";
import { PersonMenu } from "./project-live-sections";
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
      className={className}
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
      className={cn("flex scroll-mt-20 flex-col pt-9", className)}
      {...props}
    />
  );
}

/**
 * - none: no brief yet, "Собрать бриф"
 * - fresh: built from the materials as they are
 * - updating: the agent builds it, the old one (if any) is dimmed
 * - outdated: something it was built from changed, "Обновить бриф"
 */
export type BriefState = "none" | "fresh" | "updating" | "outdated";

/** The texts of the brief's head in each state. */
export interface BriefStatusView {
  fresh: string;
  outdated: string;
  outdatedNotice: { detail: string; title: string };
  /** Built from shortened materials: said under the head. */
  truncated?: string;
  updating: string;
  updatingProgress: number;
}

export function BriefSection({
  brief,
  className,
  id,
  onRefresh,
  onStop,
  state,
  status,
}: {
  /** `null`: nothing built yet. */
  brief: BriefView | null;
  className?: string;
  id?: string;
  /** "Собрать бриф" / "Обновить" / "Обновить бриф". */
  onRefresh?: () => void;
  /** "Остановить" while updating. */
  onStop?: () => void;
  state: BriefState;
  status: BriefStatusView;
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
      {status.truncated && brief && state !== "none" ? (
        <p className="text-muted-foreground text-sm">{status.truncated}</p>
      ) : null}
      {brief && state !== "none" ? (
        <BriefBody
          brief={brief}
          className={cn(state === "updating" && "opacity-45")}
        />
      ) : (
        <p className="text-muted-foreground max-w-[640px] text-base">
          {state === "updating"
            ? "Агент читает описание, заметки, людей и документы проекта."
            : "Агент соберёт бриф из описания, заметок, людей и документов проекта: продукт, стек, модули, глоссарий и ключевые документы."}
        </p>
      )}
    </section>
  );
}

function BriefMeta({
  state,
  status,
}: {
  state: BriefState;
  status: BriefStatusView;
}) {
  if (state === "updating") {
    return (
      <span className="text-foreground flex items-center gap-2">
        <Spinner className="text-accent [&_[data-slot=spinner-track]]:stroke-border" />
        {status.updating}
      </span>
    );
  }
  if (state === "none") {
    return "ещё не собран";
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
  if (state === "none") {
    return (
      <Button className="h-9 px-3.5" onClick={onRefresh}>
        Собрать бриф
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
  onEdit,
  onRemove,
  people,
  projectId = "telemedia",
}: {
  action?: ReactNode;
  className?: string;
  id?: string;
  /** "Добавить": opens "Новый человек". */
  onAdd?: () => void;
  /** "Изменить" in a person's menu. */
  onEdit?: (personId: string) => void;
  /** "Убрать из проекта" in a person's menu. */
  onRemove?: (personId: string) => void;
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
            <li className="relative flex min-w-[320px] flex-1" key={person.id}>
              <PersonCard
                className={cn("flex-1", (onEdit || onRemove) && "pr-14")}
                href={routes.person(projectId, person.id)}
                person={person}
              />
              {onEdit || onRemove ? (
                <PersonMenu
                  name={person.name}
                  onEdit={onEdit}
                  onRemove={onRemove}
                  personId={person.id}
                />
              ) : null}
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
  documents,
  id,
  integrations,
  sources,
}: {
  className?: string;
  /** "Документы с компьютера". */
  documents?: ReactNode;
  id?: string;
  /** What comes after the connected sources: the integrations to come. */
  integrations?: ReactNode;
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
      {documents ? <div className="pb-4">{documents}</div> : null}
      {sources.length === 0 && !documents ? (
        <p className="text-muted-foreground text-sm">
          Источники можно подключить в настройках, в разделе «Интеграции».
        </p>
      ) : null}
      {sources.length > 0 ? (
        <div className="flex flex-col gap-6">
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
              className={cn(
                "[&_[data-slot=item-meta]]:text-muted-foreground gap-3.5 px-0 [&_[data-slot=item-actions]]:w-20 [&_[data-slot=item-meta]]:w-50 [&_[data-slot=item-meta]]:gap-1.5",
                // A narrow panel wraps the description and the status
                // instead of cutting them.
                "@max-3xl/panel:[&_[data-slot=item-description]]:whitespace-normal @max-3xl/panel:[&_[data-slot=item-meta]]:w-36"
              )}
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
              variant="plain"
            />
          ))}
        </div>
      ) : null}
      {integrations}
    </ProjectSection>
  );
}
