"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  type CallRecord,
  countPendingProposals,
  deleteRecording,
  useCall,
} from "@/data/calls";
import { useDemoState } from "@/lib/use-demo-state";

import {
  DeleteRecordingAlert,
  type PlayerChannel,
  type PlayerSpeed,
} from "../components/transcript";
import { RECORDING, TRANSCRIPT_SECTIONS } from "../mock";
import { resolveMoment, topicOfMoment } from "../moment";
import {
  CallDetailsScreen,
  MOMENT_ELEMENT_ID,
  type PlayerState,
} from "../screens/call-details-screen";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/transcript?id=…&moment=…: "06 Детали звонка". The moment (a
 * question, a phrase or a time code) scrolls into view and glows orange for
 * four seconds, the player stands there. A question on the right does the
 * same. The player plays a fake clock; "Удалить запись" asks first and then
 * drops the audio, the transcript stays. `?demo=delete-recording` opens the
 * dialog.
 */

const DEMO_STATES = ["delete-recording"] as const;

const HIGHLIGHT_MS = 4000;
const SECOND_MS = 1000;
const SECONDS_IN_MINUTE = 60;
const SPEED_FACTOR: Record<PlayerSpeed, number> = {
  "1,5×": 1.5,
  "1×": 1,
  "2×": 2,
};

function toSeconds(time: string) {
  const [minutes = 0, seconds = 0] = time.split(":").map(Number);
  return minutes * SECONDS_IN_MINUTE + seconds;
}

function toClock(total: number) {
  const whole = Math.floor(total);
  const minutes = Math.floor(whole / SECONDS_IN_MINUTE);
  const seconds = whole % SECONDS_IN_MINUTE;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The fake playback clock: position advances while playing. */
function usePlayer(start: string, duration: string) {
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(() => toSeconds(start));
  const [speed, setSpeed] = useState<PlayerSpeed>(
    RECORDING.speed as PlayerSpeed
  );
  const [channel, setChannel] = useState<PlayerChannel>("both");
  const end = toSeconds(duration);

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(() => {
      setSeconds((current) => {
        const next = current + SPEED_FACTOR[speed];
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
    }, SECOND_MS);
    return () => clearInterval(timer);
  }, [end, playing, speed]);

  const toggle = useCallback(() => setPlaying((value) => !value), []);
  const seek = useCallback((time: string) => setSeconds(toSeconds(time)), []);

  const state: PlayerState = {
    channel,
    onChannelChange: setChannel,
    onSpeedChange: setSpeed,
    onTogglePlay: toggle,
    playing,
    position: toClock(seconds),
    speed,
  };
  return { pause: () => setPlaying(false), seek, state };
}

function TranscriptOfCall({
  call,
  initialMoment,
}: {
  call: CallRecord;
  initialMoment: string | null;
}) {
  const demo = useDemoState(DEMO_STATES);
  const [momentValue, setMomentValue] = useState(initialMoment);
  /** Bumps on every jump to a moment; `null` once the glow is over. */
  const [highlight, setHighlight] = useState<number | null>(
    initialMoment ? 0 : null
  );
  const [dialogOpen, setDialogOpen] = useState(demo === "delete-recording");
  const cancelRef = useRef<HTMLButtonElement>(null);

  const moment = useMemo(
    () => resolveMoment(TRANSCRIPT_SECTIONS, momentValue),
    [momentValue]
  );
  const [topic, setTopic] = useState(
    () =>
      topicOfMoment(TRANSCRIPT_SECTIONS, moment) ??
      TRANSCRIPT_SECTIONS[0]?.topic.id
  );
  const player = usePlayer(
    moment?.position ?? RECORDING.position,
    call.duration
  );
  const { pause, seek } = player;

  // Scroll the moment into view and let it glow for a while
  useEffect(() => {
    if (highlight === null) {
      return;
    }
    document
      .querySelector(`#${MOMENT_ELEMENT_ID}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  const selectQuestion = useCallback(
    (questionId: string) => {
      const next = resolveMoment(TRANSCRIPT_SECTIONS, questionId);
      setMomentValue(questionId);
      setHighlight((current) => (current ?? 0) + 1);
      const nextTopic = topicOfMoment(TRANSCRIPT_SECTIONS, next);
      if (nextTopic) {
        setTopic(nextTopic);
      }
      if (next?.position) {
        seek(next.position);
      }
    },
    [seek]
  );

  const changeTopic = useCallback((topicId: string) => {
    setTopic(topicId);
    document
      .querySelector(`#topic-${topicId}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  const askDelete = useCallback(() => {
    pause();
    setDialogOpen(true);
  }, [pause]);
  const confirmDelete = useCallback(() => {
    deleteRecording(call.id);
    setDialogOpen(false);
    toast.add({
      description: "Расшифровка, итоги и карточки остались",
      title: "Запись удалена",
      type: "success",
    });
  }, [call.id]);

  return (
    <>
      <CallDetailsScreen
        activeTopic={topic}
        className={APP_WINDOW}
        moment={highlight === null ? null : moment}
        onDeleteRecording={askDelete}
        onSelectQuestion={selectQuestion}
        onTopicChange={changeTopic}
        pendingProposals={countPendingProposals(call)}
        player={player.state}
        recordingDeleted={call.audioDeleted}
        sections={TRANSCRIPT_SECTIONS}
      />
      <DeleteRecordingAlert
        cancelRef={cancelRef}
        onConfirm={confirmDelete}
        onOpenChange={setDialogOpen}
        open={dialogOpen && !call.audioDeleted}
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
