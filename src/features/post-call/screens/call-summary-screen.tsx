"use client";

import {
  CallPageHeader,
  CallTitle,
  CallWindow,
  PanelPage,
  SideColumn,
  SideHeading,
} from "../components/call-window";
import { usePostCallInfo, usePostCallLinks } from "../components/links";
import {
  AgentLocalStatus,
  ProcessingSteps,
  SideCardSkeleton,
  SummarySkeleton,
} from "../components/processing";
import {
  CallMeta,
  ClickUpAnswers,
  ClickUpTile,
  SummaryPoints,
  SummarySection,
  SummaryTldr,
  UnaskedQuestions,
} from "../components/summary";
import {
  KnowledgeProposalsCard,
  SavedToast,
  TaskCardsOverviewList,
} from "../components/summary-side";
import {
  CLICKUP_ANSWERS,
  KNOWLEDGE_TARGETS,
  type KnowledgeTarget,
  PROCESSING_STEPS,
  type ProcessingStepData,
  SUMMARY_TOPICS,
  TASK_CARD_OVERVIEW,
  UNASKED_QUESTIONS,
} from "../mock";

/*
 * "01 Сборка итогов" (`processing`) and "02 Итоги звонка" (`ready`);
 * `toast` adds "Итоги сохранены" from "07 Мини-флоу" over the ready state.
 */

function ProcessingAside() {
  return (
    <SideColumn label="Обновить знания">
      <SideHeading note="появятся позже">Обновить знания</SideHeading>
      <SideCardSkeleton
        lines={["w-full", "w-[64%]"]}
        media="tile"
        titleWidth="w-[120px]"
      />
      <SideCardSkeleton
        lines={["w-[88%]"]}
        media="avatar"
        titleWidth="w-[96px]"
      />
      <AgentLocalStatus />
    </SideColumn>
  );
}

function ProcessingContent({ steps }: { steps: ProcessingStepData[] }) {
  return (
    <PanelPage className="gap-8 pb-10">
      <header className="flex flex-col gap-2.5">
        <p className="text-muted-foreground text-sm">
          Звонок завершён в 12:41, длился 40 минут
        </p>
        <CallTitle>Собираю итоги</CallTitle>
        <p className="text-muted-foreground max-w-[560px] text-lg">
          Около минуты. Окно можно закрыть, итоги появятся в истории звонков, и
          я пришлю уведомление.
        </p>
      </header>
      <ProcessingSteps steps={steps} />
      <SummarySkeleton />
    </PanelPage>
  );
}

function ReadyAside({
  proposals,
  targets,
}: {
  proposals: number;
  targets: KnowledgeTarget[];
}) {
  return (
    <SideColumn label="Знания и карточки">
      <KnowledgeProposalsCard count={proposals} targets={targets} />
      <TaskCardsOverviewList cards={TASK_CARD_OVERVIEW} />
    </SideColumn>
  );
}

function ReadyContent() {
  const answered = CLICKUP_ANSWERS.filter((item) => item.answer).length;
  const info = usePostCallInfo();
  const links = usePostCallLinks();

  return (
    <PanelPage className="gap-10">
      <CallPageHeader
        breadcrumb={[
          { href: links.project, label: info.project },
          { href: links.history, label: "Звонки" },
        ]}
        title="Итоги звонка"
      >
        <CallMeta
          date={info.dateLabel}
          duration={info.duration}
          participants={info.participants}
        />
      </CallPageHeader>
      <SummaryTldr />
      {SUMMARY_TOPICS.map((topic) => (
        <SummarySection
          id={`topic-${topic.id}`}
          key={topic.id}
          meta={topic.range}
          title={topic.title}
        >
          <SummaryPoints points={topic.points} />
        </SummarySection>
      ))}
      <SummarySection
        className="gap-1"
        count={UNASKED_QUESTIONS.length}
        countTone="accent"
        divided
        id="unasked"
        meta="перейдут в следующий звонок"
        title="Не успели спросить"
      >
        <UnaskedQuestions questions={UNASKED_QUESTIONS} />
      </SummarySection>
      <SummarySection
        count={`${answered} из ${CLICKUP_ANSWERS.length}`}
        divided
        icon={<ClickUpTile />}
        id="clickup"
        meta="в ClickUp пока не отправляем, можно скопировать"
        title="Ответы для ClickUp"
      >
        <ClickUpAnswers answers={CLICKUP_ANSWERS} />
      </SummarySection>
    </PanelPage>
  );
}

export function CallSummaryScreen({
  className,
  knowledgeTargets = KNOWLEDGE_TARGETS,
  pendingProposals = 7,
  state = "ready",
  steps = PROCESSING_STEPS,
  toast = false,
}: {
  className?: string;
  /** What the pending proposals would update, with their counts. */
  knowledgeTargets?: KnowledgeTarget[];
  pendingProposals?: number;
  state?: "processing" | "ready";
  /** Steps of the summary build, as far as it got. */
  steps?: ProcessingStepData[];
  /** "Итоги сохранены" over the window, ready state only. */
  toast?: boolean;
}) {
  if (state === "processing") {
    return (
      <CallWindow
        active="summary"
        aside={<ProcessingAside />}
        className={className}
        processing
      >
        <ProcessingContent steps={steps} />
      </CallWindow>
    );
  }

  return (
    <CallWindow
      active="summary"
      aside={
        <ReadyAside proposals={pendingProposals} targets={knowledgeTargets} />
      }
      className={className}
      overlay={
        toast ? (
          // Centered under the panel: it spans 256px from the left to 336px
          // from the right of the window.
          <SavedToast className="absolute bottom-8 left-[calc(256px+(100%-592px)/2)] z-10 -translate-x-1/2" />
        ) : null
      }
      pendingProposals={pendingProposals}
    >
      <ReadyContent />
    </CallWindow>
  );
}
