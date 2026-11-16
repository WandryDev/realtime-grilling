"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Counter } from "@/components/ui/counter";
import { cn } from "@/lib/utils";
import { CheckIcon, DocumentIcon } from "../icons";
import type { FactStatus, KnowledgeTarget, TaskCardOverview } from "../mock";
import { SideCard, SideHeading } from "./call-window";
import { LinkButton } from "./link-button";
import { usePostCallLinks } from "./links";

/*
 * Right column of "02 Итоги звонка": the proposals to update the brief and
 * profiles, and how complete each task card is.
 */

/** 26px mark of a knowledge target: a document tile or the person's letter. */
export function TargetMedia({
  className,
  initial,
}: {
  className?: string;
  initial?: string;
}) {
  if (initial) {
    return (
      <Avatar className={cn("size-[26px]", className)} size="sm">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-surface text-muted-foreground flex size-[26px] shrink-0 items-center justify-center rounded-xs",
        className
      )}
    >
      <DocumentIcon className="size-3.5" />
    </span>
  );
}

export function KnowledgeProposalsCard({
  className,
  count,
  targets,
}: {
  className?: string;
  count: number;
  targets: KnowledgeTarget[];
}) {
  const links = usePostCallLinks();
  return (
    <SideCard className={cn("gap-[18px] p-5", className)}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            Предложения обновить знания
          </h2>
          <Counter
            className="h-[22px] min-w-[22px] font-semibold"
            variant="new"
          >
            {count}
          </Counter>
        </div>
        <p className="text-muted-foreground text-sm">
          Агент заметил новое о проекте и людях. Ничего не применится, пока вы
          не примете.
        </p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {targets.map((target) => (
          <li className="flex items-center gap-2.5" key={target.id}>
            <TargetMedia initial={target.initial} />
            <span className="flex-1 text-base">{target.name}</span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {target.count}
            </span>
          </li>
        ))}
      </ul>
      <LinkButton className="w-full" href={links.proposals} size="lg">
        Разобрать предложения
      </LinkButton>
    </SideCard>
  );
}

const SEGMENT_TONE: Record<FactStatus, string> = {
  assumption: "bg-assumption",
  confirmed: "bg-confirmed",
  contradiction: "bg-contradiction",
  empty: "bg-border-strong",
};

/** Six-pixel bar split by fact status, proportional to the counts. */
export function StatusBar({
  className,
  segments,
}: {
  className?: string;
  segments: TaskCardOverview["segments"];
}) {
  return (
    <div aria-hidden="true" className={cn("flex h-1.5 gap-0.5", className)}>
      {segments.map((segment) => (
        <span
          className={cn("rounded-full", SEGMENT_TONE[segment.status])}
          key={segment.status}
          style={{ flexBasis: 0, flexGrow: segment.count }}
        />
      ))}
    </div>
  );
}

export function TaskCardsOverviewList({
  cards,
  className,
}: {
  cards: TaskCardOverview[];
  className?: string;
}) {
  const links = usePostCallLinks();
  return (
    <section
      aria-labelledby="task-cards-overview"
      className={cn("flex flex-col gap-1 px-2 pt-3", className)}
    >
      <SideHeading
        action={
          <LinkButton
            className="text-muted-foreground -mx-2 -my-[5px] px-2 font-normal"
            href={links.tasks}
            size="sm"
            variant="ghost"
          >
            открыть
          </LinkButton>
        }
        className="px-0 pt-0"
        id="task-cards-overview"
      >
        Карточки задач
      </SideHeading>
      <ul className="flex flex-col">
        {cards.map((card) => (
          <li className="flex flex-col gap-1.5 py-2.5" key={card.id}>
            <p className="text-base font-medium">{card.title}</p>
            <StatusBar segments={card.segments} />
            <p className="text-muted-foreground text-sm">{card.caption}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/*
 * "07 Мини-флоу", toast "Итоги сохранены": an ink pill with a green check,
 * two lines and the "Открыть история" action. Static, positioned by the
 * caller.
 */
export function SavedToast({ className }: { className?: string }) {
  const links = usePostCallLinks();
  return (
    <div
      className={cn(
        "bg-primary text-on-ink shadow-float flex h-[52px] items-center gap-3 rounded-full pr-2 pl-4",
        className
      )}
      role="status"
    >
      <span
        aria-hidden="true"
        className="bg-confirmed flex size-[22px] shrink-0 items-center justify-center rounded-full"
      >
        <CheckIcon className="size-3" strokeWidth={2} />
      </span>
      <div className="flex flex-col">
        <p className="text-base leading-[18px] font-medium">Итоги сохранены</p>
        <p className="text-on-ink/60 text-xs">
          на этом компьютере, вместе с записью
        </p>
      </div>
      <span
        aria-hidden="true"
        className="bg-on-ink/16 ml-1 h-6 w-px shrink-0"
      />
      <LinkButton className="h-9" href={links.history}>
        Открыть историю
      </LinkButton>
    </div>
  );
}
