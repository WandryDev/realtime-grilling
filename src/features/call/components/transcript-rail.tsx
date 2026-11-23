"use client";

import { Avatar, AvatarFallback } from "@grill/ui/avatar";
import { Button } from "@grill/ui/button";
import { useCallback } from "react";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import { PanelExpandIcon } from "../icons";
import { useCallColumns } from "./call-window";

/*
 * The transcript collapsed to a 52px rail: the expand button on top, then
 * who is talking right now (orange ring and voice bars) and "Вы". It stays
 * in a narrow window's row; expanding there opens the transcript's drawer.
 */
export function TranscriptRail({
  className,
  speaker = "client",
}: {
  className?: string;
  /** Who is speaking now. */
  speaker?: "client" | "me" | null;
}) {
  const { onToggleTranscript } = useCallActions();
  const columns = useCallColumns();
  const expand = useCallback(() => {
    onToggleTranscript?.();
    // CallWindow closes it again where the column fits in the row
    columns?.transcript.toggle();
  }, [columns, onToggleTranscript]);

  return (
    <section
      aria-label="Расшифровка, свёрнута"
      className={cn(
        "flex w-[52px] shrink-0 flex-col items-center gap-4 pt-4",
        className
      )}
    >
      <Button
        aria-label="Развернуть расшифровку"
        className="bg-background shadow-touch hover:bg-border size-9"
        onClick={expand}
        size="icon"
        variant="secondary"
      >
        <PanelExpandIcon />
      </Button>
      <span aria-hidden="true" className="bg-border-strong h-px w-5" />
      <ul className="flex flex-col items-center gap-4">
        <RailSpeaker
          initials="К"
          name="Клиент"
          speaking={speaker === "client"}
        />
        <RailSpeaker
          initials="Вы"
          muted
          name="Вы"
          speaking={speaker === "me"}
        />
      </ul>
    </section>
  );
}

function RailSpeaker({
  initials,
  muted = false,
  name,
  speaking,
}: {
  initials: string;
  /** Gray initials, for you. */
  muted?: boolean;
  name: string;
  speaking: boolean;
}) {
  return (
    <li className="flex flex-col items-center gap-2">
      <Avatar aria-hidden="true" size="sm" speaking={speaking}>
        <AvatarFallback className={cn(muted && "text-muted-foreground")}>
          {initials}
        </AvatarFallback>
      </Avatar>
      <span className="sr-only">
        {name}
        {speaking ? ", говорит сейчас" : null}
      </span>
      {speaking ? <VoiceBars /> : null}
    </li>
  );
}

/** Three vertical bars under the speaking avatar. */
function VoiceBars() {
  return (
    <span
      aria-hidden="true"
      className="*:bg-subtle flex flex-col items-center gap-[3px] *:w-[3px] *:rounded-full"
    >
      <span className="h-1.5" />
      <span className="h-3" />
      <span className="h-2" />
    </span>
  );
}
