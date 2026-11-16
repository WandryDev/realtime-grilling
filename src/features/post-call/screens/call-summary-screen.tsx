"use client";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
  CALL_FACTS,
  type CallFact,
  CLICKUP_ANSWERS,
  type ClickUpAnswer,
  KNOWLEDGE_TARGETS,
  type KnowledgeTarget,
  PROCESSING_STEPS,
  type ProcessingStepData,
  SUMMARY_TLDR,
  SUMMARY_TOPICS,
  type SummaryTopic,
  TASK_CARD_OVERVIEW,
  type TaskCardOverview,
  UNASKED_QUESTIONS,
  type UnaskedQuestion,
} from "../mock";

/*
 * "01 Сборка итогов" (`processing`) and "02 Итоги звонка" (`ready`);
 * `toast` adds "Итоги сохранены" from "07 Мини-флоу" over the ready state.
 * The app passes the call's records; without them the screen shows the
 * Телемедиа demo. A summary that was not built (`failure`) says why and
 * offers «Собрать итоги» over what the records still give: the questions,
 * the counters and the cards.
 */

/** «Итоги не собраны»: why, and «Собрать итоги». */
export interface SummaryFailure {
  onRebuild?: () => void;
  /** «Итоги не собраны: <reason>». */
  reason: string;
}

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

function ProcessingContent({
  finishedNote,
  onStop,
  steps,
}: {
  finishedNote: string;
  onStop?: () => void;
  steps: ProcessingStepData[];
}) {
  return (
    <PanelPage className="gap-8 pb-10">
      <header className="flex flex-col gap-2.5">
        <p className="text-muted-foreground text-sm">{finishedNote}</p>
        <CallTitle>Собираю итоги</CallTitle>
        <p className="text-muted-foreground max-w-[560px] text-lg">
          Около минуты. Окно можно закрыть, итоги появятся в истории звонков.
        </p>
        {onStop ? (
          <div className="pt-1.5">
            <Button onClick={onStop} variant="secondary">
              Остановить
            </Button>
          </div>
        ) : null}
      </header>
      <ProcessingSteps steps={steps} />
      <SummarySkeleton />
    </PanelPage>
  );
}

/** The proposals and the cards; nothing of what the call doesn't have. */
function ReadyAside({
  cards,
  proposals,
  targets,
}: {
  cards: TaskCardOverview[];
  proposals: number;
  targets: KnowledgeTarget[];
}) {
  return (
    <SideColumn label="Знания и карточки">
      {proposals > 0 ? (
        <KnowledgeProposalsCard count={proposals} targets={targets} />
      ) : null}
      {cards.length > 0 ? <TaskCardsOverviewList cards={cards} /> : null}
    </SideColumn>
  );
}

function FailureNotice({ failure }: { failure: SummaryFailure }) {
  return (
    <Alert variant="warning">
      <AlertTitle>{`Итоги не собраны: ${failure.reason}`}</AlertTitle>
      <AlertDescription>
        Расшифровка, вопросы и карточки звонка сохранены. Итоги можно собрать
        снова.
      </AlertDescription>
      {failure.onRebuild ? (
        <AlertAction>
          <Button onClick={failure.onRebuild} size="sm">
            Собрать итоги
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

function ClickUpSection({ answers }: { answers: ClickUpAnswer[] }) {
  const answered = answers.filter((item) => item.answer).length;
  return (
    <SummarySection
      count={`${answered} из ${answers.length}`}
      icon={<ClickUpTile />}
      id="clickup"
      meta="в ClickUp пока не отправляем, можно скопировать"
      separate
      title="Ответы для ClickUp"
    >
      <ClickUpAnswers answers={answers} />
    </SummarySection>
  );
}

function ReadyContent({
  callTitle,
  clickUpAnswers,
  failure,
  tldr,
  topics,
  unasked,
}: {
  callTitle?: string;
  clickUpAnswers: ClickUpAnswer[] | null;
  failure: SummaryFailure | null;
  tldr: typeof SUMMARY_TLDR | null;
  topics: SummaryTopic[];
  unasked: UnaskedQuestion[];
}) {
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
        {callTitle ? (
          <p className="text-xl font-medium text-balance">{callTitle}</p>
        ) : null}
        <CallMeta
          date={info.dateLabel}
          duration={info.duration}
          participants={info.participants}
        />
      </CallPageHeader>
      {failure ? <FailureNotice failure={failure} /> : null}
      {tldr ? <SummaryTldr tldr={tldr} /> : null}
      {topics.map((topic) => (
        <SummarySection
          id={`topic-${topic.id}`}
          key={topic.id}
          meta={topic.range}
          title={topic.title}
        >
          <SummaryPoints points={topic.points} />
        </SummarySection>
      ))}
      {unasked.length > 0 ? (
        <SummarySection
          className="gap-1"
          count={unasked.length}
          countTone="accent"
          id="unasked"
          meta="открытые и без ответа"
          separate
          title="Не успели спросить"
        >
          <UnaskedQuestions questions={unasked} />
        </SummarySection>
      ) : null}
      {clickUpAnswers ? <ClickUpSection answers={clickUpAnswers} /> : null}
    </PanelPage>
  );
}

export function CallSummaryScreen({
  callTitle,
  className,
  clickUpAnswers = CLICKUP_ANSWERS,
  facts = CALL_FACTS,
  failure = null,
  finishedNote = "Звонок завершён в 12:41, длился 40 минут",
  knowledgeTargets = KNOWLEDGE_TARGETS,
  onStop,
  pendingProposals = 7,
  state = "ready",
  steps = PROCESSING_STEPS,
  taskCardOverview = TASK_CARD_OVERVIEW,
  taskCards,
  tldr = SUMMARY_TLDR,
  toast = false,
  topics = SUMMARY_TOPICS,
  unasked = UNASKED_QUESTIONS,
}: {
  /** The summary's name of the call, under the page title. */
  callTitle?: string;
  className?: string;
  /** «Ответы для ClickUp»; `null` hides the section (no integration). */
  clickUpAnswers?: ClickUpAnswer[] | null;
  /** The call in the sidebar while the summary is built. */
  facts?: CallFact[];
  /** The summary was not built: why, and «Собрать итоги». */
  failure?: SummaryFailure | null;
  /** «Звонок завершён в …» over «Собираю итоги». */
  finishedNote?: string;
  /** What the pending proposals would update, with their counts. */
  knowledgeTargets?: KnowledgeTarget[];
  /** «Остановить» the build; hidden without it. */
  onStop?: () => void;
  pendingProposals?: number;
  state?: "processing" | "ready";
  /** Steps of the summary build, as far as it got. */
  steps?: ProcessingStepData[];
  /** How complete each task card is, in the right column. */
  taskCardOverview?: TaskCardOverview[];
  /** The count of «Карточки задач» in the sidebar. */
  taskCards?: number;
  /** «Коротко» and its chips; `null` without a summary or its text. */
  tldr?: typeof SUMMARY_TLDR | null;
  /** "Итоги сохранены" over the window, ready state only. */
  toast?: boolean;
  topics?: SummaryTopic[];
  /** «Не успели спросить»; hidden when empty. */
  unasked?: UnaskedQuestion[];
}) {
  if (state === "processing") {
    return (
      <CallWindow
        active="summary"
        aside={<ProcessingAside />}
        className={className}
        facts={facts}
        processing
      >
        <ProcessingContent
          finishedNote={finishedNote}
          onStop={onStop}
          steps={steps}
        />
      </CallWindow>
    );
  }

  return (
    <CallWindow
      active="summary"
      aside={
        pendingProposals > 0 || taskCardOverview.length > 0 ? (
          <ReadyAside
            cards={taskCardOverview}
            proposals={pendingProposals}
            targets={knowledgeTargets}
          />
        ) : undefined
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
      taskCards={taskCards}
    >
      <ReadyContent
        callTitle={callTitle}
        clickUpAnswers={clickUpAnswers}
        failure={failure}
        tldr={tldr}
        topics={topics}
        unasked={unasked}
      />
    </CallWindow>
  );
}
