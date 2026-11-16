"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import type { SummaryCard } from "@/bindings";
import { toast } from "@/components/ui/toast";
import {
  updateCallCard,
  useCallCards,
  useCallQuestions,
  useCallTranscript,
} from "@/data/call-records";
import { type CallRecord, useCall } from "@/data/calls";
import { usePendingProposals } from "@/data/proposals";
import { useCallSummary } from "@/data/summaries";
import { routes } from "@/lib/routes";

import {
  EditTaskCardDialog,
  TaskCardActions,
  type TaskCardCommand,
} from "../components/task-card-actions";
import type { TaskCardData, TaskFactData } from "../mock";
import { TaskCardsScreen } from "../screens/task-cards-screen";
import { nextQuestions, speakerOf, taskCards } from "./call-data";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/tasks?id=…: "03 Карточки задач" of the call (`call_cards`): the
 * saved summary's cards with their facts, or before a summary (or after a
 * failed one) the cards the fast loop made during the call. Every card is
 * stacked with its seven lenses, the topic pills scroll to them, a source
 * opens its quote; «Открыть в расшифровке» opens the details page at the
 * phrase, «Послушать» also plays it from there. A card is accepted, renamed, discarded and
 * brought back through `call_card_update`; sending to ClickUp or GitHub
 * is «скоро».
 */

function scrollToTopic(topicId: string) {
  document
    .querySelector(`#topic-${topicId}`)
    ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

const DECISIONS = {
  accept: "accepted",
  discard: "discarded",
  restore: "pending",
} as const;

function TaskCardsOfCall({ call }: { call: CallRecord }) {
  const router = useRouter();
  const { data: records, status: cardsStatus } = useCallCards(call.id);
  const { summary } = useCallSummary(call.id);
  const recordings = useCallTranscript(call.id).data;
  const questions = useCallQuestions(call.id).data;
  const pendingProposals = usePendingProposals(call.id);
  const [expandedFactId, setExpandedFactId] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  const content =
    records.source === "summary" ? (summary?.content ?? null) : null;
  const speaker = speakerOf(
    call.participantIds.length === 1 ? [call.participants] : []
  );
  const cards = useMemo(
    () => taskCards(records, content, { questions, recordings, speaker }),
    [content, questions, recordings, records, speaker]
  );
  const topics = useMemo(
    () =>
      cards.map((card) => ({
        count: card.fields.reduce(
          (total, field) =>
            total +
            field.facts.filter((fact) => fact.status !== "empty").length,
          0
        ),
        id: card.id,
        title: card.title,
      })),
    [cards]
  );
  const askNext = useMemo(() => nextQuestions(records.next), [records.next]);
  const decisions = useMemo(
    () =>
      new Map<string, SummaryCard["decision"]>(
        records.cards.map((card) => [card.id, card.decision])
      ),
    [records.cards]
  );
  const foldedCardIds = useMemo(
    () =>
      records.cards
        .filter((card) => card.decision === "discarded")
        .map((card) => card.id),
    [records.cards]
  );

  const changeTopic = useCallback((topicId: string) => {
    setTopic(topicId);
    scrollToTopic(topicId);
  }, []);

  const toggleFact = useCallback((factId: string) => {
    setExpandedFactId((current) => (current === factId ? null : factId));
  }, []);

  // «Послушать»: the details page plays the recording from the phrase.
  const audioDeleted =
    recordings.length > 0 && recordings.every((item) => item.audioDeleted);
  const listen = useCallback(
    (fact: TaskFactData) => {
      if (audioDeleted) {
        toast.add({
          description: "Запись удалена, осталась только расшифровка",
          title: "Нечего проигрывать",
          type: "info",
        });
        return;
      }
      const moment = fact.quote?.moment ?? fact.quote?.time;
      router.push(routes.callTranscript(call.id, moment, true));
    },
    [audioDeleted, call.id, router]
  );

  const command = useCallback(
    async (cardId: string, next: TaskCardCommand) => {
      if (next === "edit") {
        setEditingCardId(cardId);
        return;
      }
      const saved = await updateCallCard(call.id, cardId, {
        decision: DECISIONS[next],
      });
      if (!saved) {
        return;
      }
      if (next === "accept") {
        toast.add({
          description: "Отправка в ClickUp и GitHub появится позже",
          title: `Карточка «${saved.title}» принята`,
          type: "success",
        });
      } else if (next === "discard") {
        toast.add({
          actionProps: {
            children: "Вернуть",
            onClick: () => {
              updateCallCard(call.id, cardId, { decision: "pending" });
            },
          },
          title: `Карточка «${saved.title}» отброшена`,
          type: "success",
        });
      }
    },
    [call.id]
  );

  const renderActions = useCallback(
    (card: TaskCardData) => (
      <TaskCardActions
        cardId={card.id}
        decision={decisions.get(card.id) ?? "pending"}
        onCommand={command}
      />
    ),
    [command, decisions]
  );

  const editing = cards.find((card) => card.id === editingCardId);
  const closeEditor = useCallback((open: boolean) => {
    if (!open) {
      setEditingCardId(null);
    }
  }, []);
  const saveTitle = useCallback(
    async (title: string) => {
      if (!editingCardId) {
        return;
      }
      setEditingCardId(null);
      const saved = await updateCallCard(call.id, editingCardId, { title });
      if (saved) {
        toast.add({ title: "Карточка обновлена", type: "success" });
      }
    },
    [call.id, editingCardId]
  );

  return (
    <>
      <TaskCardsScreen
        activeTopic={topic ?? cards[0]?.id}
        cards={cards}
        className={APP_WINDOW}
        expandedFactId={expandedFactId}
        foldedCardIds={foldedCardIds}
        loading={cardsStatus === "loading"}
        nextQuestions={askNext}
        onListen={listen}
        onToggleFact={toggleFact}
        onTopicChange={changeTopic}
        pendingProposals={pendingProposals}
        renderActions={renderActions}
        topics={topics}
      />
      <EditTaskCardDialog
        onOpenChange={closeEditor}
        onSave={saveTitle}
        open={editing !== undefined}
        title={editing?.title ?? ""}
      />
    </>
  );
}

export function TaskCardsPage() {
  const params = useSearchParams();
  const call = useCall(params.get("id"));

  return (
    <CallPageFrame call={call}>
      {call ? <TaskCardsOfCall call={call} /> : null}
    </CallPageFrame>
  );
}
