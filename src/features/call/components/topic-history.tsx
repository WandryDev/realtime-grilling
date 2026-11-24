"use client";

import {
  QuestionHistory,
  QuestionHistoryAnswer,
  QuestionHistoryContent,
  QuestionHistoryHeader,
  QuestionHistoryItem,
  QuestionHistoryList,
  QuestionHistoryNote,
  QuestionHistoryQuestion,
  QuestionHistoryRestore,
  QuestionHistoryTime,
} from "@grill/ui/question-history";
import { useCallback } from "react";

import { useCallActions } from "../call-actions";
import type { HistoryEntry, TopicHistoryData } from "../types";

/** "Обсудили в этой теме": questions already dealt with in the topic. */
export function TopicHistory({
  className,
  history,
  topicId,
}: {
  className?: string;
  history: TopicHistoryData;
  /** Topic the rows belong to, passed to the "Вернуть" handler. */
  topicId?: string;
}) {
  return (
    <QuestionHistory className={className}>
      <QuestionHistoryHeader count={history.count}>
        Обсудили в этой теме
      </QuestionHistoryHeader>
      <QuestionHistoryList>
        {history.items.map((entry) => (
          <HistoryRow entry={entry} key={entry.id} topicId={topicId} />
        ))}
      </QuestionHistoryList>
    </QuestionHistory>
  );
}

function HistoryRow({
  entry,
  topicId,
}: {
  entry: HistoryEntry;
  topicId?: string;
}) {
  const { onRestore } = useCallActions();
  const restore = useCallback(() => {
    if (topicId !== undefined) {
      onRestore?.(topicId, entry.id);
    }
  }, [entry.id, onRestore, topicId]);

  return (
    <QuestionHistoryItem status={entry.status}>
      <QuestionHistoryContent>
        <QuestionHistoryQuestion>{entry.question}</QuestionHistoryQuestion>
        {entry.answer ? (
          <QuestionHistoryAnswer>{entry.answer}</QuestionHistoryAnswer>
        ) : null}
        {entry.note ? (
          <QuestionHistoryNote>{entry.note}</QuestionHistoryNote>
        ) : null}
      </QuestionHistoryContent>
      {entry.time ? (
        <QuestionHistoryTime>{entry.time}</QuestionHistoryTime>
      ) : (
        <QuestionHistoryRestore onClick={restore} />
      )}
    </QuestionHistoryItem>
  );
}
