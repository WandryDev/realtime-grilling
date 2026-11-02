"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  type CallRecord,
  countPendingProposals,
  getTaskCardReview,
  type TaskSyncService,
  updateTaskCard,
  useCall,
} from "@/data/calls";
import { useIntegrations } from "@/data/integrations";
import { routes } from "@/lib/routes";

import { sendTaskCard } from "../api";
import {
  EditTaskCardDialog,
  TaskCardActions,
  type TaskCardCommand,
} from "../components/task-card-actions";
import {
  TASK_CARDS,
  TASK_TOPICS,
  type TaskCardData,
  type TaskFactData,
} from "../mock";
import { TaskCardsScreen } from "../screens/task-cards-screen";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/tasks?id=…: "03 Карточки задач". Both cards of the call stacked,
 * the topic pills scroll to them, a source opens its quote. Each card can
 * be accepted, edited or discarded; an accepted card goes to ClickUp or
 * GitHub (simulated in ../api.ts) when that integration is connected.
 */

const SERVICE_NAME: Record<TaskSyncService, string> = {
  clickup: "ClickUp",
  github: "GitHub",
};

function scrollToTopic(topicId: string) {
  document
    .querySelector(`#topic-${topicId}`)
    ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function TaskCardsOfCall({ call }: { call: CallRecord }) {
  const integrations = useIntegrations();
  const [expandedFactId, setExpandedFactId] = useState<string | null>(null);
  const [topic, setTopic] = useState(TASK_TOPICS[0]?.id ?? "calls");
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  const cards = useMemo(
    () =>
      TASK_CARDS.map((card) => ({
        ...card,
        title: getTaskCardReview(call, card.id).title ?? card.title,
      })),
    [call]
  );
  const foldedCardIds = useMemo(
    () =>
      cards
        .filter(
          (card) => getTaskCardReview(call, card.id).decision === "discarded"
        )
        .map((card) => card.id),
    [call, cards]
  );
  const statuses = useMemo(
    () => ({
      clickup: integrations.clickup.status,
      github: integrations.github.status,
    }),
    [integrations]
  );

  const changeTopic = useCallback((topicId: string) => {
    setTopic(topicId);
    scrollToTopic(topicId);
  }, []);

  const toggleFact = useCallback((factId: string) => {
    setExpandedFactId((current) => (current === factId ? null : factId));
  }, []);

  const listen = useCallback(
    (fact: TaskFactData) => {
      toast.add({
        description: call.audioDeleted
          ? "Запись удалена, осталась только расшифровка"
          : fact.quote?.text,
        title: call.audioDeleted
          ? "Нечего проигрывать"
          : `Играет фрагмент ${fact.quote?.time ?? ""}`,
        type: "info",
      });
    },
    [call.audioDeleted]
  );

  const command = useCallback(
    (cardId: string, next: TaskCardCommand) => {
      const title = cards.find((card) => card.id === cardId)?.title ?? "";
      if (next === "edit") {
        setEditingCardId(cardId);
        return;
      }
      const decision = {
        accept: "accepted",
        discard: "discarded",
        restore: "pending",
      } as const;
      updateTaskCard(call.id, cardId, (review) => ({
        ...review,
        decision: decision[next],
      }));
      if (next === "accept") {
        toast.add({
          description: "Её можно отправить в ClickUp или GitHub",
          title: `Карточка «${title}» принята`,
          type: "success",
        });
      } else if (next === "discard") {
        toast.add({
          actionProps: {
            children: "Вернуть",
            onClick: () =>
              updateTaskCard(call.id, cardId, (review) => ({
                ...review,
                decision: "pending",
              })),
          },
          title: `Карточка «${title}» отброшена`,
          type: "success",
        });
      }
    },
    [call.id, cards]
  );

  const send = useCallback(
    async (cardId: string, service: TaskSyncService) => {
      const ref = await sendTaskCard(call.id, cardId, service);
      toast.add({
        description:
          service === "clickup"
            ? "Задача создана в списке проекта"
            : "Issue создан в репозитории проекта",
        title: `Отправлено в ${SERVICE_NAME[service]}: ${ref}`,
        type: "success",
      });
    },
    [call.id]
  );

  const renderActions = useCallback(
    (card: TaskCardData) => (
      <TaskCardActions
        cardId={card.id}
        connectHref={routes.settings("integrations")}
        integrations={statuses}
        onCommand={command}
        onSend={send}
        review={getTaskCardReview(call, card.id)}
      />
    ),
    [call, command, send, statuses]
  );

  const editing = cards.find((card) => card.id === editingCardId);
  const closeEditor = useCallback((open: boolean) => {
    if (!open) {
      setEditingCardId(null);
    }
  }, []);
  const saveTitle = useCallback(
    (title: string) => {
      if (!editingCardId) {
        return;
      }
      updateTaskCard(call.id, editingCardId, (review) => ({
        ...review,
        title,
      }));
      setEditingCardId(null);
      toast.add({ title: "Карточка обновлена", type: "success" });
    },
    [call.id, editingCardId]
  );

  return (
    <>
      <TaskCardsScreen
        activeTopic={topic}
        cards={cards}
        className={APP_WINDOW}
        expandedFactId={expandedFactId}
        foldedCardIds={foldedCardIds}
        onListen={listen}
        onToggleFact={toggleFact}
        onTopicChange={changeTopic}
        pendingProposals={countPendingProposals(call)}
        renderActions={renderActions}
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
