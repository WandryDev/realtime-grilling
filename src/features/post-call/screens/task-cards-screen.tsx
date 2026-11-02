"use client";

import { type ReactNode, useCallback } from "react";

import { Tabs, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  CallPageHeader,
  CallWindow,
  PanelPage,
  SideColumn,
  SideHeading,
} from "../components/call-window";
import { usePostCallInfo, usePostCallLinks } from "../components/links";
import { NavMeta } from "../components/panel-nav";
import {
  NextQuestionCard,
  StatusLegend,
  TaskCardField,
  TaskCardHeading,
  TaskFact,
} from "../components/task-cards";
import {
  NEXT_QUESTIONS,
  TASK_CARD,
  TASK_TOPICS,
  type TaskCardData,
  type TaskFactData,
} from "../mock";

/*
 * "03 Карточки задач": the card of the selected topic with its seven fields;
 * `expandedFactId` opens the source quote of one fact. The app stacks every
 * card of the call (`cards`), the topic pills scroll to them, and each card
 * gets its decisions (`renderActions`); a discarded card folds to its title.
 */

function TaskCard({
  actions,
  card,
  expandedFactId,
  folded,
  onListen,
  onToggleFact,
}: {
  actions?: ReactNode;
  card: TaskCardData;
  expandedFactId: string | null;
  folded: boolean;
  onListen?: (fact: TaskFactData) => void;
  onToggleFact?: (factId: string) => void;
}) {
  const headingId = `task-card-${card.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex scroll-mt-6 flex-col gap-7"
      id={`topic-${card.id}`}
    >
      <TaskCardHeading
        actions={actions}
        className={folded ? "text-muted-foreground" : undefined}
        id={headingId}
        meta={folded ? "отброшена" : card.discussed}
        title={card.title}
      />
      {folded ? null : (
        <dl className="flex flex-col">
          {card.fields.map((field) => {
            const highlighted = field.facts.some(
              (fact) => fact.id === expandedFactId && fact.quote
            );
            return (
              <TaskCardField
                highlighted={highlighted}
                key={field.id}
                label={field.label}
              >
                {field.facts.map((fact) => (
                  <TaskFact
                    expanded={fact.id === expandedFactId}
                    fact={fact}
                    key={fact.id}
                    onListen={onListen}
                    onToggle={onToggleFact}
                  />
                ))}
              </TaskCardField>
            );
          })}
        </dl>
      )}
    </section>
  );
}

export function TaskCardsScreen({
  activeTopic,
  card = TASK_CARD,
  cards,
  className,
  expandedFactId = "queue",
  foldedCardIds,
  onListen,
  onToggleFact,
  onTopicChange,
  pendingProposals,
  renderActions,
}: {
  /** Selected topic pill (app). */
  activeTopic?: string;
  card?: TaskCardData;
  /** Every card of the call, stacked (app); `card` alone by default. */
  cards?: TaskCardData[];
  className?: string;
  /** Fact whose source is open, showing the phrase from the transcript. */
  expandedFactId?: string | null;
  /** Discarded cards: only the title and the actions stay. */
  foldedCardIds?: string[];
  onListen?: (fact: TaskFactData) => void;
  onToggleFact?: (factId: string) => void;
  /** Makes the topic pills controlled. */
  onTopicChange?: (topicId: string) => void;
  pendingProposals?: number;
  renderActions?: (card: TaskCardData) => ReactNode;
}) {
  const info = usePostCallInfo();
  const links = usePostCallLinks();
  const list = cards ?? [card];
  const changeTopic = useCallback(
    (value: unknown) => {
      if (typeof value === "string") {
        onTopicChange?.(value);
      }
    },
    [onTopicChange]
  );
  const controlled = onTopicChange !== undefined;

  return (
    <CallWindow
      active="tasks"
      aside={
        <SideColumn label="Спросить в следующий раз">
          <SideHeading action={<NavMeta>{NEXT_QUESTIONS.length}</NavMeta>}>
            Спросить в следующий раз
          </SideHeading>
          <ul className="flex flex-col gap-2.5">
            {NEXT_QUESTIONS.map((question) => (
              <NextQuestionCard key={question.id} question={question} />
            ))}
          </ul>
          <p className="text-muted-foreground px-2 py-1 text-sm">
            Агент подмешает их в начало следующего звонка по проекту
          </p>
        </SideColumn>
      }
      className={className}
      pendingProposals={pendingProposals}
      taskCards={cards?.length}
    >
      <PanelPage>
        <CallPageHeader
          breadcrumb={[
            { href: links.project, label: info.project },
            { href: links.summary, label: info.callLabel },
          ]}
          title="Карточки задач"
        />
        <div className="border-border flex items-center justify-between gap-6 border-b pb-4">
          <Tabs
            defaultValue={controlled ? undefined : TASK_TOPICS[0]?.id}
            onValueChange={controlled ? changeTopic : undefined}
            value={controlled ? activeTopic : undefined}
          >
            <TabsList aria-label="Темы">
              {TASK_TOPICS.map((topic) => (
                <TabsTrigger key={topic.id} value={topic.id}>
                  {topic.title}
                  <TabsCount>{topic.count}</TabsCount>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <StatusLegend />
        </div>
        {list.map((item) => (
          <TaskCard
            actions={renderActions?.(item)}
            card={item}
            expandedFactId={expandedFactId}
            folded={foldedCardIds?.includes(item.id) ?? false}
            key={item.id}
            onListen={onListen}
            onToggleFact={onToggleFact}
          />
        ))}
      </PanelPage>
    </CallWindow>
  );
}
