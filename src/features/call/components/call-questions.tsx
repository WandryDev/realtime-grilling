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
    earlier = [],
    empty,
    finalCheck,
    frozen = false,
    highlightedId,
    hoveredId,
    noTopic,
    parkedFinalCheck,
    previous,
    usage,
  } = questions;
  const prefix = useId();

  return (
    <QuestionsPanel
      className={className}
      nav={
        <QuestionsNav
          agent={agent}
          anchors={anchors}
          finalCheckCount={
            parkedFinalCheck ? parkedFinalCheck.questions.length + 1 : undefined
          }
          sectionIdPrefix={prefix}
          usage={usage}
        />
      }
    >
      {banner ? <AgentBanner banner={banner} className="mt-3" /> : null}
      {empty ? <ListeningEmpty empty={empty} /> : null}
      {finalCheck ? (
        <FinalCheck
          finalCheck={finalCheck}
          highlightedId={highlightedId}
          id={topicSectionId(prefix, FINAL_CHECK_TOPIC_ID)}
        />
      ) : null}
      {current ? (
        <CurrentTopic
          frozen={frozen}
          highlightedId={highlightedId}
          hoveredId={hoveredId}
          id={topicSectionId(prefix, current.id)}
          topic={current}
        />
      ) : null}
      {previous ? (
        <EarlierTopic
          className="pt-4"
          highlightedId={highlightedId}
          id={topicSectionId(prefix, previous.id)}
          topic={previous}
        />
      ) : null}
      {earlier.map((topic) => (
        <EarlierTopic
          className="pt-4"
          highlightedId={highlightedId}
          id={topicSectionId(prefix, topic.id)}
          key={topic.id}
          topic={topic}
        />
      ))}
      {noTopic ? (
        <EarlierTopic
          className="pt-2"
          highlightedId={highlightedId}
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
  highlightedId,
  hoveredId,
  id,
  topic,
}: {
  className?: string;
  frozen?: boolean;
  highlightedId?: string;
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
        <PinnedQuestion
          highlighted={topic.pinned.id === highlightedId}
          question={topic.pinned}
          topicId={topic.id}
        />
      ) : null}
      {topic.main ? (
        <MainQuestion
          frozen={frozen}
          highlighted={
            topic.main.id !== undefined && topic.main.id === highlightedId
          }
          question={topic.main}
        />
      ) : null}
      {topic.questions.map((question) => (
        <OpenQuestion
          frozen={frozen}
          highlighted={question.id === highlightedId}
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
  highlightedId,
  id,
  topic,
}: {
  className?: string;
  highlightedId?: string;
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
        <OpenQuestion
          highlighted={question.id === highlightedId}
          key={question.id}
          question={question}
          variant="compact"
        />
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
  highlightedId,
  id,
}: {
  className?: string;
  finalCheck: FinalCheckData;
  highlightedId?: string;
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
        <MainQuestion
          highlighted={
            finalCheck.main.id !== undefined &&
            finalCheck.main.id === highlightedId
          }
          question={finalCheck.main}
        />
        {finalCheck.questions.map((question) => (
          <OpenQuestion
            highlighted={question.id === highlightedId}
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
