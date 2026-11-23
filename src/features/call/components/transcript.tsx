"use client";

import { Avatar, AvatarFallback } from "@grill/ui/avatar";
import { Bubble } from "@grill/ui/bubble";
import { Button } from "@grill/ui/button";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageSpeaking,
  MessageTyping,
} from "@grill/ui/message";
import { Skeleton } from "@grill/ui/skeleton";
import { Spinner } from "@grill/ui/spinner";
import { TopicDivider } from "@grill/ui/topic-divider";
import { type ReactNode, useEffect, useRef } from "react";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import type {
  TranscriptItem,
  TranscriptNoticeData,
  TranscriptUnavailableData,
} from "../types";

const CLIENT_INITIAL = "К";

/*
 * Left column of the call window, 340 wide on the window gray: the
 * "Расшифровка" header with "свернуть", then topic dividers and messages
 * 18px apart.
 *
 * A change of `scrollKey` (new phrases) keeps the column pinned to the
 * latest phrase, unless you scrolled up to read.
 */
export function TranscriptColumn({
  children,
  className,
  scrollKey,
}: {
  children: ReactNode;
  className?: string;
  scrollKey?: unknown;
}) {
  const { onToggleTranscript } = useCallActions();
  const ref = useStickToBottom(scrollKey);

  return (
    <section
      aria-label="Расшифровка"
      className={cn(
        "flex w-[340px] shrink-0 flex-col gap-[18px] overflow-y-auto px-4 py-3",
        className
      )}
      ref={ref}
    >
      <header className="flex items-center justify-between pt-2">
        <h2 className="text-sm font-semibold">Расшифровка</h2>
        <Button
          className="-mx-2 -my-[5px] px-2 font-normal"
          onClick={onToggleTranscript}
          size="sm"
          variant="ghost"
        >
          свернуть
        </Button>
      </header>
      {children}
    </section>
  );
}

/** How close to the end still counts as "reading the latest phrase". */
const STICK_THRESHOLD = 80;

function useStickToBottom(scrollKey: unknown) {
  const ref = useRef<HTMLElement>(null);
  const stuck = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      stuck.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <
        STICK_THRESHOLD;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // Only changes scroll: the first render keeps the column at its top
  const lastKey = useRef(scrollKey);
  useEffect(() => {
    const element = ref.current;
    const changed = lastKey.current !== scrollKey;
    lastKey.current = scrollKey;
    if (!(changed && element && stuck.current)) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [scrollKey]);

  return ref;
}

/** Topic dividers and messages; later dividers get 6px more air above. */
export function TranscriptItems({ items }: { items: TranscriptItem[] }) {
  const firstTopic = items.find((item) => item.kind === "topic");

  return items.map((item) => (
    <TranscriptEntry
      className={cn(
        item.kind === "topic" && item !== firstTopic ? "pt-1.5" : undefined
      )}
      item={item}
      key={item.id}
    />
  ));
}

export function TranscriptEntry({
  className,
  item,
}: {
  className?: string;
  item: TranscriptItem;
}) {
  switch (item.kind) {
    case "topic":
      return (
        <TopicDivider className={className} time={item.time}>
          {item.title}
        </TopicDivider>
      );
    case "me":
      return (
        <Message align="end" className={className}>
          <MessageContent>
            <MessageHeader>
              Вы
              {item.live ? (
                <MessageSpeaking>расшифровываю</MessageSpeaking>
              ) : null}
            </MessageHeader>
            {/* The call window lets your bubbles span the column, as in Paper */}
            <Bubble className="group-data-[align=end]/message:max-w-full">
              {item.live ? <TranscribingLines /> : null}
              {item.text}
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "missing":
      return (
        <MissingSpeech
          className={className}
          duration={item.duration}
          label={item.label}
        />
      );
    default:
      return (
        <ClientMessage
          className={className}
          footer={item.footer}
          live={item.live}
          text={item.text}
        />
      );
  }
}

function ClientMessage({
  className,
  footer,
  live,
  text,
}: Omit<Extract<TranscriptItem, { kind: "client" }>, "id" | "kind"> & {
  className?: string;
}) {
  const transcribing = live === "transcribing";

  return (
    <Message className={className}>
      <MessageAvatar speaking={Boolean(live)}>
        <AvatarFallback>{CLIENT_INITIAL}</AvatarFallback>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>
          Клиент
          {live ? (
            <MessageSpeaking>
              {transcribing ? "расшифровываю" : null}
            </MessageSpeaking>
          ) : null}
        </MessageHeader>
        <Bubble variant="card">
          {transcribing ? <TranscribingLines /> : null}
          <span>{text}</span>
          {live ? <MessageTyping /> : null}
        </Bubble>
        {footer ? (
          <MessageFooter status={footer.status}>
            {footer.text}
            {footer.time ? (
              <>
                {" "}
                <button type="button">{footer.time}</button>
              </>
            ) : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

/** Two gray lines where the text of a phrase being transcribed will be. */
function TranscribingLines() {
  return (
    <span className="flex w-[200px] flex-col gap-2 py-1">
      <Skeleton className="h-2.5 w-full" tone="surface" />
      <Skeleton className="h-2.5 w-[70%]" tone="surface" />
    </span>
  );
}

/**
 * Client speech without system audio: a dashed placeholder with how long
 * the client talked.
 */
export function MissingSpeech({
  className,
  duration,
  label,
}: {
  className?: string;
  duration: string;
  label: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Avatar aria-hidden="true" size="sm">
        <AvatarFallback className="bg-surface text-muted-foreground">
          {CLIENT_INITIAL}
        </AvatarFallback>
      </Avatar>
      <p className="border-border-strong text-muted-foreground flex h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-dashed px-3.5 text-sm">
        <span>
          <span className="sr-only">Клиент: </span>
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums">{duration}</span>
      </p>
    </div>
  );
}

/** Plate at the top of the column while the transcript lags behind. */
export function TranscriptNotice({
  className,
  notice,
}: {
  className?: string;
  notice: TranscriptNoticeData;
}) {
  return (
    <div
      className={cn(
        "bg-background shadow-touch flex items-start gap-2.5 rounded-sm py-3 pr-3.5 pl-3",
        className
      )}
      role="status"
    >
      <span aria-hidden="true" className="flex shrink-0 pt-0.5">
        <Spinner className="text-assumption [&_[data-slot=spinner-track]]:stroke-border size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <p className="font-semibold">{notice.title}</p>
        <p className="text-muted-foreground">{notice.description}</p>
      </div>
    </div>
  );
}

/**
 * Recognition doesn't work this call: what is wrong and, for a missing or
 * broken model, the way to Settings. Takes the place of the feed.
 */
export function TranscriptUnavailable({
  className,
  unavailable,
}: {
  className?: string;
  unavailable: TranscriptUnavailableData;
}) {
  return (
    <div
      className={cn(
        "bg-background shadow-touch flex flex-col items-start gap-3 rounded-sm px-3.5 py-3",
        className
      )}
      role="status"
    >
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <p className="font-semibold">{unavailable.title}</p>
        <p className="text-muted-foreground">{unavailable.description}</p>
      </div>
      {unavailable.settingsHref ? (
        <Button
          size="sm"
          variant="secondary"
          {...linkButtonProps(unavailable.settingsHref)}
        >
          Открыть настройки
        </Button>
      ) : null}
    </div>
  );
}
