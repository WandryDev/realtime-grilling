"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";

import type { FinalCheckData, QuestionsData, TopicData } from "../types";
import { AgentBanner, FinalCheckBanner } from "./banners";
import { ListeningEmpty } from "./listening-empty";
import { MainQuestion, OpenQuestion, PinnedQuestion } from "./question-rows";
import {
  QuestionsNav,
  QuestionsPanel,
  TopicSection,
  topicSectionId,
} from "./questions-panel";
import { TopicHistory } from "./topic-history";

/** Topic id the final check list answers to in handlers and anchors. */
export const FINAL_CHECK_TOPIC_ID = "final-check";

/*
 * The questions panel filled from data, top to bottom: anchors, an agent
 * banner, the empty state or the final check, the current topic, the
 * previous one and "Без темы".
 */
export function CallQuestions({
  className,
  questions,
}: {
  className?: string;
  questions: QuestionsData;
}) {
  const {
    agent,
    anchors,
    banner,
    current,
    empty,
    finalCheck,
    frozen = false,
    hoveredId,
    noTopic,
    previous,
  } = questions;
  const prefix = useId();

  return (
    <QuestionsPanel
      className={className}
      nav={
        <QuestionsNav
          agent={agent}
          anchors={anchors}
          sectionIdPrefix={prefix}
        />
      }
    >
      {banner ? <AgentBanner banner={banner} className="mt-3" /> : null}
      {empty ? <ListeningEmpty empty={empty} /> : null}
      {finalCheck ? (
        <FinalCheck
          finalCheck={finalCheck}
          id={topicSectionId(prefix, FINAL_CHECK_TOPIC_ID)}
        />
      ) : null}
      {current ? (
        <CurrentTopic
          frozen={frozen}
          hoveredId={hoveredId}
          id={topicSectionId(prefix, current.id)}
          topic={current}
        />
      ) : null}
      {previous ? (
        <EarlierTopic
          className="pt-4"
          id={topicSectionId(prefix, previous.id)}
          topic={previous}
        />
      ) : null}
      {noTopic ? (
        <EarlierTopic
          className="pt-2"
          id={topicSectionId(prefix, noTopic.id)}
          topic={noTopic}
        />
      ) : null}
    </QuestionsPanel>
  );
}

/** The topic under discussion: pinned, main, the rest, what was discussed. */
export function CurrentTopic({
  className,
  frozen = false,
  hoveredId,
  id,
  topic,
}: {
  className?: string;
  frozen?: boolean;
  hoveredId?: string;
  id?: string;
  topic: TopicData;
}) {
  return (
    <TopicSection
      className={className}
      id={id}
      meta={topic.meta}
      title={topic.title}
    >
      {topic.pinned ? (
        <PinnedQuestion question={topic.pinned} topicId={topic.id} />
      ) : null}
      {topic.main ? (
        <MainQuestion frozen={frozen} question={topic.main} />
      ) : null}
      {topic.questions.map((question) => (
        <OpenQuestion
          frozen={frozen}
          hovered={question.id === hoveredId}
          key={question.id}
          question={question}
          topicId={topic.id}
        />
      ))}
      {topic.history ? (
        <TopicHistory history={topic.history} topicId={topic.id} />
      ) : null}
    </TopicSection>
  );
}

/** Earlier topics and "Без темы": compact rows under a hairline. */
export function EarlierTopic({
  className,
  id,
  topic,
}: {
  className?: string;
  id?: string;
  topic: TopicData;
}) {
  return (
    <TopicSection
      className={className}
      id={id}
      meta={topic.meta}
      title={topic.title}
      variant="divided"
    >
      {topic.questions.map((question) => (
        <OpenQuestion key={question.id} question={question} variant="compact" />
      ))}
      {topic.history ? (
        <TopicHistory
          className="mt-1"
          history={topic.history}
          topicId={topic.id}
        />
      ) : null}
    </TopicSection>
  );
}

/**
 * Switched on by the agent near the end of the call: the banner, then the
 * 3–5 most important questions across topics, the first one as the main.
 */
export function FinalCheck({
  className,
  finalCheck,
  id,
}: {
  className?: string;
  finalCheck: FinalCheckData;
  id?: string;
}) {
  return (
    <div
      className={cn("flex scroll-mt-16 flex-col gap-2 pt-4 pb-12", className)}
      id={id}
    >
      <FinalCheckBanner banner={finalCheck.banner} />
      <TopicSection
        meta={finalCheck.meta}
        title={finalCheck.title}
        variant="plain"
      >
        <MainQuestion question={finalCheck.main} />
        {finalCheck.questions.map((question) => (
          <OpenQuestion
            key={question.id}
            pinnable={false}
            question={question}
            topicId={FINAL_CHECK_TOPIC_ID}
          />
        ))}
      </TopicSection>
    </div>
  );
}
