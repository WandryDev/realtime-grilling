"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CallRecording, RecordingPeaks } from "@/bindings";
import { toast } from "@/components/ui/toast";
import {
  recordingAudioUrl,
  useCallQuestions,
  useCallTranscript,
  useRecordingPeaks,
} from "@/data/call-records";
import { type CallRecord, deleteRecording, useCall } from "@/data/calls";
import { countPending, useCallProposals } from "@/data/proposals";
import { useCallSummary } from "@/data/summaries";
import type { Synced } from "@/data/synced-store";
import { plural } from "@/lib/plural";
import { useDemoState } from "@/lib/use-demo-state";

import {
  DeleteRecordingAlert,
  type PlayerChannel,
  type PlayerPart,
  WAVEFORM_BARS,
} from "../components/transcript";
import {
  buildTranscript,
  clockTime,
  playerClock,
  questionItems,
  resolveMoment,
  topicOfMoment,
} from "../moment";
import { usePlayer } from "../player";
import {
  CallDetailsScreen,
  MOMENT_ELEMENT_ID,
  type TranscriptNotice,
  TURN_ELEMENT_ID,
} from "../screens/call-details-screen";
import { matchRanges } from "../text-match";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/transcript?id=…&moment=…: "06 Детали звонка" of a call. The
 * transcript of every recording by the summary's topics, the questions of
 * the call, the search in the transcript and the player of the recording
 * (post-call design.md, decisions 9–11; `call-details`).
 *
 * The moment (`?moment=`, see ../moment.ts) scrolls into view and glows
 * orange for four seconds, the player stands there. A question on the
 * right does the same: its answer, or the phrase it rests on. A call with
 * several recordings plays one part at a time. «Удалить запись» asks
 * first, then deletes the audio of every recording; the transcript and the
 * summary stay, the player goes. `?demo=delete-recording` opens the dialog.
 */

const DEMO_STATES = ["delete-recording"] as const;

const HIGHLIGHT_MS = 4000;
const BYTES_PER_MB = 1_000_000;
const ROUND_MB_FROM = 10;
const MS_PER_MINUTE = 60_000;

/** «13 МБ», «0,6 МБ». */
function formatSize(bytes: number) {
  const mb = bytes / BYTES_PER_MB;
  const shown =
    mb >= ROUND_MB_FROM
      ? String(Math.round(mb))
      : mb.toFixed(1).replace(".", ",");
  return `${shown} МБ`;
}

function audioBytes(recordings: CallRecording[]) {
  return recordings.reduce(
    (sum, item) => sum + (item.meBytes ?? 0) + (item.othersBytes ?? 0),
    0
  );
}

/** «Opus, 2 канала, 13 МБ. В облако не выгружается.» */
function recordingDescription(playable: CallRecording[]) {
  const channels = Math.max(
    ...playable.map(
      (item) =>
        Number(item.meBytes !== null) + Number(item.othersBytes !== null)
    ),
    0
  );
  const parts =
    playable.length > 1
      ? `${playable.length} ${plural(playable.length, "часть", "части", "частей")}, `
      : "";
  return `${parts}Opus, ${channels} ${plural(channels, "канал", "канала", "каналов")}, ${formatSize(audioBytes(playable))}. В облако не выгружается.`;
}

/** «Аудио 19 октября, 40 минут, 13 МБ, удалится с этого компьютера. …» */
function deleteDescription(call: CallRecord, playable: CallRecording[]) {
  const minutes = Math.max(
    1,
    Math.round(
      playable.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) /
        MS_PER_MINUTE
    )
  );
  return `Аудио ${call.day}, ${minutes} ${plural(minutes, "минута", "минуты", "минут")}, ${formatSize(audioBytes(playable))}, удалится с этого компьютера. Вернуть его не получится.`;
}

/** The waveform of the channels the manager hears. */
function peaksOf(peaks: RecordingPeaks, channel: PlayerChannel) {
  const bars = Math.max(peaks.me.length, peaks.others.length);
  return Array.from({ length: bars }, (_, index) => {
    const me = peaks.me[index] ?? 0;
    const others = peaks.others[index] ?? 0;
    if (channel === "you") {
      return me;
    }
    if (channel === "client") {
      return others;
    }
    return Math.max(me, others);
  });
}

/** What shows instead of the transcript: loading, failed, no phrases. */
function noticeOf(
  transcript: Synced<CallRecording[]>,
  turns: number
): TranscriptNotice | undefined {
  if (transcript.status === "loading") {
    return { description: "Это займёт секунду.", title: "Читаю расшифровку" };
  }
  if (transcript.status === "error") {
    return {
      description:
        transcript.error?.message ?? "Попробуйте открыть звонок ещё раз.",
      title: "Расшифровка не открылась",
    };
  }
  if (turns === 0) {
    return {
      description:
        transcript.data.length > 0
          ? "В записи этого звонка не нашлось ни одной фразы."
          : "У этого звонка нет записи.",
      title: "Расшифровки нет",
    };
  }
}

function showPlaybackError() {
  toast.add({
    description: "Файлы записи не открылись. Попробуйте ещё раз.",
    title: "Запись не играет",
    type: "error",
  });
}

function TranscriptOfCall({
  call,
  initialMoment,
}: {
  call: CallRecord;
  initialMoment: string | null;
}) {
  const demo = useDemoState(DEMO_STATES);
  const transcript = useCallTranscript(call.id);
  const questions = useCallQuestions(call.id);
  const { summary } = useCallSummary(call.id);
  const proposals = useCallProposals(call.id);
  const recordings = transcript.data;
  const topics = summary?.content?.topics;

  const model = useMemo(
    () => buildTranscript(recordings, topics),
    [recordings, topics]
  );
  const items = useMemo(
    () => questionItems(recordings, questions.data),
    [questions.data, recordings]
  );

  const [momentValue, setMomentValue] = useState(initialMoment);
  /** Bumps on every jump to a moment; `null` once the glow is over. */
  const [highlight, setHighlight] = useState<number | null>(
    initialMoment ? 0 : null
  );
  const moment = useMemo(
    () => resolveMoment(model, questions.data, momentValue),
    [model, momentValue, questions.data]
  );
  const [topic, setTopic] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(demo === "delete-recording");
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The parts of the call the player can play.
  const playable = useMemo(
    () =>
      recordings.filter(
        (item) => !item.audioDeleted && item.durationMs !== null
      ),
    [recordings]
  );
  const [partId, setPartId] = useState<string | undefined>(undefined);
  const part =
    playable.find((item) => item.id === partId) ??
    playable.find((item) => item.id === moment?.at?.recordingId) ??
    playable[0];
  const leadUrl = part ? recordingAudioUrl(part.id, "others") : null;
  const followerUrl = part ? recordingAudioUrl(part.id, "me") : null;
  const durationMs = part?.durationMs ?? 0;
  const player = usePlayer({
    durationMs,
    hasAudio: leadUrl !== null && followerUrl !== null,
    initialMs:
      moment?.at && moment.at.recordingId === part?.id ? moment.at.startMs : 0,
    onError: showPlaybackError,
    recordingId: part?.id ?? null,
  });
  const { pause, seek } = player;
  const peaks = useRecordingPeaks(part?.id, WAVEFORM_BARS);

  /** Stands the player at a moment, switching to its part. */
  const standAt = useCallback(
    (at: { recordingId: string; startMs: number } | undefined) => {
      if (!(at && playable.some((item) => item.id === at.recordingId))) {
        return;
      }
      if (at.recordingId !== part?.id) {
        pause();
        setPartId(at.recordingId);
      }
      seek(at.startMs);
    },
    [part?.id, pause, playable, seek]
  );

  // The moment of the link stands the player there once it is read.
  const linked = useRef<boolean>(false);
  useEffect(() => {
    if (linked.current || !moment?.at) {
      return;
    }
    linked.current = true;
    standAt(moment.at);
  }, [moment, standAt]);

  // Scroll the moment into view and let it glow for a while
  const momentTurn = moment?.turnIds[0];
  useEffect(() => {
    if (highlight === null || !momentTurn) {
      return;
    }
    document
      .querySelector(`[id="${MOMENT_ELEMENT_ID}"]`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight, momentTurn]);

  const found = useMemo(
    () =>
      query.trim()
        ? model.turns.filter((turn) => matchRanges(turn.text, query).length > 0)
        : [],
    [model.turns, query]
  );
  const firstFound = found[0]?.id;
  useEffect(() => {
    if (firstFound) {
      document
        .querySelector(`[id="${TURN_ELEMENT_ID}${firstFound}"]`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }
  }, [firstFound]);

  const selectQuestion = useCallback(
    (questionId: string) => {
      const next = resolveMoment(model, questions.data, questionId);
      setMomentValue(questionId);
      setHighlight((current) => (current ?? 0) + 1);
      const nextTopic = topicOfMoment(model.sections, next);
      if (nextTopic) {
        setTopic(nextTopic);
      }
      standAt(next?.at);
    },
    [model, questions.data, standAt]
  );

  const changeTopic = useCallback((topicId: string) => {
    setTopic(topicId);
    document
      .querySelector(`[id="topic-${topicId}"]`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  const changePart = useCallback(
    (id: string) => {
      pause();
      setPartId(id);
      seek(0);
    },
    [pause, seek]
  );

  const seekShare = useCallback(
    (share: number) => seek(share * durationMs),
    [durationMs, seek]
  );

  const askDelete = useCallback(() => {
    pause();
    setDialogOpen(true);
  }, [pause]);
  const confirmDelete = useCallback(async () => {
    setDialogOpen(false);
    // Through the calls store, so the other pages read the audio gone too.
    if (await deleteRecording(call.id)) {
      toast.add({
        description: "Расшифровка, итоги и карточки остались",
        title: "Запись удалена",
        type: "success",
      });
    }
  }, [call.id]);

  const parts = useMemo<PlayerPart[]>(
    () =>
      playable.length > 1
        ? playable.map((item, index) => ({
            id: item.id,
            label: `Часть ${index + 1}, ${clockTime(item.startedAt).slice(0, 5)}`,
          }))
        : [],
    [playable]
  );

  const audioDeleted =
    transcript.status === "ready" &&
    recordings.length > 0 &&
    playable.length === 0;

  const notice = noticeOf(transcript, model.turns.length);

  const activeTopic =
    topic ??
    topicOfMoment(model.sections, moment) ??
    model.sections[0]?.topic.id;

  return (
    <>
      <CallDetailsScreen
        activeTopic={activeTopic}
        className={APP_WINDOW}
        moment={highlight === null ? null : moment}
        notice={notice}
        onDeleteRecording={askDelete}
        onSelectQuestion={selectQuestion}
        onTopicChange={changeTopic}
        pendingProposals={countPending(proposals.data)}
        player={{
          channel: player.channel,
          duration: playerClock(durationMs),
          onChannelChange: player.changeChannel,
          onPartChange: changePart,
          onSeek: part ? seekShare : undefined,
          onSpeedChange: player.changeSpeed,
          onTogglePlay: player.toggle,
          part: part?.id,
          parts,
          peaks:
            peaks.status === "ready" && peaks.data.durationMs > 0
              ? peaksOf(peaks.data, player.channel)
              : undefined,
          playing: player.playing,
          position: playerClock(player.positionMs),
          progress: durationMs > 0 ? player.positionMs / durationMs : 0,
          speed: player.speed,
        }}
        questions={items}
        recordingDeleted={audioDeleted}
        recordingDescription={recordingDescription(playable)}
        search={{ found: found.length, onQueryChange: setQuery, query }}
        sections={model.sections}
      />
      {part && leadUrl && followerUrl ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: the transcript next to it is the text of the recording */}
          <audio
            data-channel="others"
            key={`${part.id}-others`}
            preload="auto"
            ref={player.leadRef}
            src={leadUrl}
          />
          {/* biome-ignore lint/a11y/useMediaCaption: the transcript next to it is the text of the recording */}
          <audio
            data-channel="me"
            key={`${part.id}-me`}
            preload="auto"
            ref={player.followerRef}
            src={followerUrl}
          />
        </>
      ) : null}
      <DeleteRecordingAlert
        cancelRef={cancelRef}
        description={deleteDescription(call, playable)}
        onConfirm={confirmDelete}
        onOpenChange={setDialogOpen}
        open={dialogOpen && !audioDeleted}
      />
    </>
  );
}

export function TranscriptPage() {
  const params = useSearchParams();
  const call = useCall(params.get("id"));
  const moment = params.get("moment");

  return (
    <CallPageFrame call={call}>
      {call ? (
        <TranscriptOfCall
          call={call}
          initialMoment={moment}
          key={`${call.id}:${moment ?? ""}`}
        />
      ) : null}
    </CallPageFrame>
  );
}
