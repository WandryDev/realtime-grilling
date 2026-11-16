"use client";

/*
 * "06 Детали звонка": the full transcript with topic anchors, the pinned
 * audio player, the questions of the call on the right and the dialog that
 * deletes the recording. Client module: the static dialog reuses the class
 * constants of alert-dialog.tsx.
 */

import {
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  useCallback,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogSurfaceClassName,
  dialogTitleClassName,
} from "@/components/ui/alert-dialog";
import { AvatarFallback } from "@/components/ui/avatar";
import { Bubble } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { cn } from "@/lib/utils";

import {
  CheckIcon,
  ChevronDownIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from "../icons";
import {
  type CallQuestion,
  DELETE_RECORDING,
  RECORDING,
  type TranscriptTurnData,
  WAVEFORM,
} from "../mock";
import { matchRanges } from "../text-match";
import { SideCard, SideHeading } from "./call-window";
import { DoneCheck, OpenRing, StatusDot } from "./status-mark";

/** `text` with the matches of `query` marked. */
function Marked({ query, text }: { query?: string; text: string }) {
  const ranges = query ? matchRanges(text, query) : [];
  if (ranges.length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(from, start));
    parts.push(
      <mark
        className="bg-accent-soft text-foreground rounded-[4px] px-0.5 font-semibold"
        key={start}
      >
        {text.slice(start, end)}
      </mark>
    );
    from = end;
  }
  parts.push(text.slice(from));
  return parts;
}

/** One phrase: the client on the left in white, you on the right in ink. */
export function TranscriptTurn({
  className,
  id,
  query,
  turn,
}: {
  className?: string;
  id?: string;
  /** Marks what the search in the transcript found. */
  query?: string;
  turn: TranscriptTurnData;
}) {
  const isClient = turn.speaker === "client";
  const time = (
    <span className="font-mono text-xs font-normal tabular-nums">
      {turn.time}
    </span>
  );

  return (
    <Message
      align={isClient ? "start" : "end"}
      className={cn("scroll-mt-24", className)}
      data-turn-id={turn.id}
      id={id}
    >
      {isClient ? (
        <MessageAvatar>
          <AvatarFallback>К</AvatarFallback>
        </MessageAvatar>
      ) : null}
      <MessageContent className="group-data-[align=end]/message:gap-1.5">
        <MessageHeader className="gap-2.5">
          {isClient ? <>Клиент {time}</> : <>{time} Вы</>}
        </MessageHeader>
        <Bubble
          className={isClient ? "max-w-[520px]" : "max-w-[480px]"}
          variant={isClient ? "card" : "default"}
        >
          <Marked query={query} text={turn.text} />
        </Bubble>
      </MessageContent>
    </Message>
  );
}

/** Soft orange block around the moment a question was asked. */
export function MomentHighlight({
  children,
  className,
  id,
  label,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "bg-accent-soft -mx-4 flex scroll-mt-24 flex-col gap-[18px] rounded-md px-4 pt-3.5 pb-[18px]",
        className
      )}
      id={id}
    >
      <p className="text-accent-ink flex items-center gap-2 text-sm font-medium">
        <StatusDot tone="accent" />
        {label}
      </p>
      {children}
    </section>
  );
}

/** Duration "40:12" in seconds. */
function toSeconds(time: string) {
  const [minutes = 0, seconds = 0] = time.split(":").map(Number);
  return minutes * 60 + seconds;
}

const WAVE_WIDTH = 574;
const WAVE_HEIGHT = 28;
const WAVE_STEP = 6;
const BAR_WIDTH = 4;
const MIN_BAR = 3;
const PERCENT = 100;
const SEEK_STEPS = 1000;

/** As many bars as the Paper waveform draws. */
export const WAVEFORM_BARS = Math.ceil(WAVE_WIDTH / WAVE_STEP);

/** Peaks (0–1) as bars of the waveform box, centred. */
function peakBars(peaks: readonly number[]): [number, number][] {
  return peaks.slice(0, WAVEFORM_BARS).map((peak) => {
    const height = Math.max(
      MIN_BAR,
      Math.round(Math.min(Math.max(peak, 0), 1) * WAVE_HEIGHT)
    );
    return [(WAVE_HEIGHT - height) / 2, height];
  });
}

/**
 * Recorded waveform: played bars in ink, the rest gray, a playhead. With
 * `onSeek` a click or the arrow keys move the position.
 */
export function Waveform({
  className,
  onSeek,
  peaks,
  position,
  progress,
}: {
  className?: string;
  /** Seeks to a share of the recording, 0 to 1. */
  onSeek?: (progress: number) => void;
  /** The recording's peaks, 0 to 1; the Paper bars by default. */
  peaks?: readonly number[];
  /** «12:04 из 40:12»: what a screen reader says of the position. */
  position?: string;
  /** Played share, 0 to 1. */
  progress: number;
}) {
  const playedWidth = progress * WAVE_WIDTH;
  const bars = peaks ? peakBars(peaks) : WAVEFORM;
  const seek = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onSeek?.(Number(event.target.value) / SEEK_STEPS),
    [onSeek]
  );

  return (
    <div
      className={cn("relative flex h-7 min-w-0 flex-1 items-center", className)}
    >
      <svg
        aria-hidden="true"
        className="h-7 w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`}
      >
        {bars.map(([y, height], index) => {
          const x = index * WAVE_STEP;
          return (
            <rect
              className={
                x < playedWidth ? "fill-foreground" : "fill-border-strong"
              }
              height={height}
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are a fixed list, the position is the identity
              key={index}
              rx="2"
              width={BAR_WIDTH}
              x={x}
              y={y}
            />
          );
        })}
      </svg>
      <span
        aria-hidden="true"
        className="bg-foreground absolute top-0 h-7 w-0.5 rounded-[1px]"
        style={{ left: `${(progress * PERCENT).toFixed(1)}%` }}
      />
      {onSeek ? (
        <input
          aria-label="Позиция записи"
          aria-valuetext={position}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          max={SEEK_STEPS}
          min={0}
          onChange={seek}
          type="range"
          value={Math.round(progress * SEEK_STEPS)}
        />
      ) : null}
    </div>
  );
}

export const PLAYER_SPEEDS = ["1×", "1,5×", "2×"] as const;

export type PlayerSpeed = (typeof PLAYER_SPEEDS)[number];

export const PLAYER_CHANNELS = [
  { id: "both", label: "Оба канала" },
  { id: "you", label: "Только вы" },
  { id: "client", label: "Только клиент" },
] as const;

export type PlayerChannel = (typeof PLAYER_CHANNELS)[number]["id"];

/** A part of a call recorded again after «Отменить завершение». */
export interface PlayerPart {
  id: string;
  label: string;
}

/** A menu of a secondary button: the channel, the part of the call. */
function PlayerMenu({
  label,
  onValueChange,
  name,
  options,
  value,
}: {
  label: string;
  /** What the button picks, for a screen reader: «Часть записи». */
  name?: string;
  onValueChange?: (value: string) => void;
  options: readonly { id: string; label: string }[];
  value: string;
}) {
  const change = useCallback(
    (next: unknown) => {
      const found = options.find((item) => item.id === next);
      if (found) {
        onValueChange?.(found.id);
      }
    },
    [onValueChange, options]
  );
  const button = (
    <Button
      aria-label={name ? `${name}: ${label}` : undefined}
      className="h-7 gap-1.5 px-2.5 font-normal"
      size="sm"
      variant="secondary"
    >
      {label}
      <ChevronDownIcon className="text-muted-foreground size-2.5" />
    </Button>
  );

  if (!onValueChange) {
    return button;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={button} />
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuRadioGroup onValueChange={change} value={value}>
          {options.map((item) => (
            <DropdownMenuRadioItem closeOnClick key={item.id} value={item.id}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Channel picker of the player: a static button in /dev, a menu in the app. */
function ChannelButton({
  channel,
  onChannelChange,
}: {
  channel: PlayerChannel;
  onChannelChange?: (channel: PlayerChannel) => void;
}) {
  const change = useCallback(
    (value: string) => {
      const next = PLAYER_CHANNELS.find((item) => item.id === value);
      if (next) {
        onChannelChange?.(next.id);
      }
    },
    [onChannelChange]
  );
  const label =
    PLAYER_CHANNELS.find((item) => item.id === channel)?.label ?? "";
  return (
    <PlayerMenu
      label={label}
      onValueChange={onChannelChange ? change : undefined}
      options={PLAYER_CHANNELS}
      value={channel}
    />
  );
}

/** Player pinned to the bottom of the panel. */
export function AudioPlayer({
  channel = "both",
  className,
  disabled = false,
  duration,
  oneChannel = false,
  onChannelChange,
  onPartChange,
  onSeek,
  onSpeedChange,
  onTogglePlay,
  part,
  parts = [],
  peaks,
  playing = true,
  position,
  progress: progressProp,
  speed = RECORDING.speed as PlayerSpeed,
}: {
  channel?: PlayerChannel;
  className?: string;
  /** Nothing to play yet (or at all): the controls are unavailable. */
  disabled?: boolean;
  duration: string;
  onChannelChange?: (channel: PlayerChannel) => void;
  /** The recording has one channel file: nothing to pick. */
  oneChannel?: boolean;
  onPartChange?: (partId: string) => void;
  /** Seeks to a share of the recording, 0 to 1. */
  onSeek?: (progress: number) => void;
  onSpeedChange?: (speed: PlayerSpeed) => void;
  onTogglePlay?: () => void;
  /** The part that plays, of `parts`. */
  part?: string;
  /** Parts of a call with several recordings; none for one. */
  parts?: readonly PlayerPart[];
  /** The waveform's peaks, 0 to 1. */
  peaks?: readonly number[];
  playing?: boolean;
  position: string;
  /** Played share, 0 to 1; from `position` and `duration` by default. */
  progress?: number;
  speed?: PlayerSpeed;
}) {
  const progress =
    progressProp ?? Math.min(toSeconds(position) / toSeconds(duration), 1);
  const nextSpeed = useCallback(() => {
    const index = PLAYER_SPEEDS.indexOf(speed);
    onSpeedChange?.(PLAYER_SPEEDS[(index + 1) % PLAYER_SPEEDS.length] ?? "1×");
  }, [onSpeedChange, speed]);
  const current = parts.find((item) => item.id === part) ?? parts[0];

  return (
    <section
      aria-label="Запись звонка"
      className={cn(
        "bg-background shadow-float flex h-[72px] items-center gap-4 rounded-lg pr-5 pl-4",
        className
      )}
    >
      <Button
        aria-label={playing ? "Пауза" : "Слушать"}
        disabled={disabled}
        onClick={onTogglePlay}
        size="icon-lg"
      >
        {playing ? (
          <PauseIcon className="size-3.5" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
      </Button>
      <p className="flex w-[52px] shrink-0 flex-col font-mono tabular-nums">
        <span className="text-sm">{position}</span>
        <span className="text-muted-foreground text-xs">{duration}</span>
      </p>
      <Waveform
        onSeek={disabled ? undefined : onSeek}
        peaks={peaks}
        position={`${position} из ${duration}`}
        progress={progress}
      />
      {parts.length > 1 && current ? (
        <PlayerMenu
          label={current.label}
          name="Часть записи"
          onValueChange={onPartChange}
          options={parts}
          value={current.id}
        />
      ) : null}
      <Button
        aria-label={`Скорость ${speed}`}
        className="h-7 px-2.5 font-mono text-xs font-normal"
        onClick={onSpeedChange ? nextSpeed : undefined}
        size="sm"
        variant="secondary"
      >
        {speed}
      </Button>
      {oneChannel ? null : (
        <ChannelButton channel={channel} onChannelChange={onChannelChange} />
      )}
    </section>
  );
}

function QuestionMark({ status }: { status: CallQuestion["status"] }) {
  if (status === "answered") {
    return <DoneCheck className="mt-0.5 size-3.5" />;
  }
  if (status === "open") {
    return <OpenRing className="mt-1 size-2" />;
  }
  return <StatusDot className="mt-[5px]" tone="assumption" />;
}

const QUESTION_STATUS_LABEL = {
  answered: "отвечен",
  assumption: "допущение",
  open: "без ответа",
} as const;

function QuestionButton({
  active,
  onSelect,
  question,
}: {
  active: boolean;
  onSelect?: (questionId: string) => void;
  question: CallQuestion;
}) {
  const select = useCallback(
    () => onSelect?.(question.id),
    [onSelect, question.id]
  );
  return (
    <button
      aria-current={active ? "true" : undefined}
      className={cn(
        "hover:bg-border focus-visible:focus-ring flex w-full gap-2.5 rounded-sm px-2 py-2.5 text-left transition-colors",
        "aria-[current=true]:bg-background aria-[current=true]:shadow-card"
      )}
      onClick={onSelect ? select : undefined}
      type="button"
    >
      <span className="flex w-4 shrink-0 justify-center">
        <QuestionMark status={question.status} />
        <span className="sr-only">
          {QUESTION_STATUS_LABEL[question.status]}:{" "}
        </span>
      </span>
      <span className="min-w-0 flex-1 text-base">{question.text}</span>
      <span className="text-muted-foreground font-mono text-xs leading-5 tabular-nums">
        {question.time}
      </span>
    </button>
  );
}

/** Questions of the call; a click jumps the transcript to the moment. */
export function CallQuestionList({
  activeId,
  className,
  onSelect,
  questions,
}: {
  /** The question whose moment is highlighted. */
  activeId?: string;
  className?: string;
  onSelect?: (questionId: string) => void;
  questions: CallQuestion[];
}) {
  return (
    <section
      aria-labelledby="call-questions"
      className={cn("flex flex-col gap-0.5", className)}
    >
      <SideHeading
        className="pb-2.5"
        id="call-questions"
        note="клик, чтобы перейти"
      >
        Вопросы звонка
      </SideHeading>
      <ul className="flex flex-col gap-0.5">
        {questions.map((question) => (
          <li key={question.id}>
            <QuestionButton
              active={question.id === activeId}
              onSelect={onSelect}
              question={question}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The recording stays on this computer; it can be deleted from here. */
export function RecordingCard({
  className,
  deleted = false,
  description = RECORDING.description,
  onDelete,
}: {
  className?: string;
  /** The audio is gone; transcript and moments still work. */
  deleted?: boolean;
  /** «Opus, 2 канала, 13 МБ. В облако не выгружается.» */
  description?: string;
  onDelete?: () => void;
}) {
  if (deleted) {
    return (
      <SideCard className={cn("gap-2", className)}>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <TrashIcon className="text-muted-foreground size-3.5 shrink-0" />
          Запись удалена
        </h2>
        <p className="text-muted-foreground text-sm">
          Расшифровка, итоги и карточки остались. Таймкоды работают без звука.
        </p>
      </SideCard>
    );
  }
  return (
    <SideCard className={cn("gap-2", className)}>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <LockIcon className="text-muted-foreground size-3.5 shrink-0" />
        {RECORDING.title}
      </h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      <Button
        className="text-destructive hover:bg-contradiction-soft hover:text-destructive -mx-2 -my-[5px] w-fit px-2"
        onClick={onDelete}
        size="sm"
        variant="ghost"
      >
        Удалить запись
      </Button>
    </SideCard>
  );
}

/* Shared by the static dialog of /dev and the live one of the app */
function DeleteRecordingMark() {
  return (
    <span
      aria-hidden="true"
      className="bg-contradiction-soft text-contradiction flex size-10 items-center justify-center rounded-sm"
    >
      <TrashIcon className="size-[18px]" />
    </span>
  );
}

function DeleteRecordingKeeps() {
  return (
    <div className="bg-surface flex flex-col gap-2 rounded-md px-4 py-3.5 text-sm">
      <p className="font-medium">Останется</p>
      <ul className="flex flex-col gap-2">
        {DELETE_RECORDING.keeps.map((item) => (
          <li className="flex items-center gap-2" key={item}>
            <CheckIcon className="text-confirmed size-3.5 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const DELETE_FOOTER_CLASS_NAME = "gap-3 [&>button]:h-10 [&>button]:px-[18px]";

/*
 * The live "Удалить запись звонка?" of the app. Focus starts on "Отмена",
 * Esc closes; "Удалить запись" calls `onConfirm` and the caller closes it.
 */
export function DeleteRecordingAlert({
  cancelRef,
  description = DELETE_RECORDING.description,
  onConfirm,
  onOpenChange,
  open,
}: {
  cancelRef: RefObject<HTMLButtonElement | null>;
  /** What goes: «Аудио 19 октября, 40 минут, 13 МБ, удалится …». */
  description?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent className="sm:max-w-[400px]" initialFocus={cancelRef}>
        <DeleteRecordingMark />
        <AlertDialogHeader>
          <AlertDialogTitle>{DELETE_RECORDING.title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <DeleteRecordingKeeps />
        <AlertDialogFooter className={DELETE_FOOTER_CLASS_NAME}>
          <AlertDialogCancel ref={cancelRef}>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            Удалить запись
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/*
 * "07 Мини-флоу", deleting the recording: the window dims and the dialog
 * says what goes (the audio) and what stays. Static, drawn over the window.
 */
export function DeleteRecordingDialog({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "bg-foreground/24 dark:bg-scrim absolute inset-0 z-10 flex items-center justify-center",
        className
      )}
    >
      <div
        aria-describedby="delete-recording-text"
        aria-labelledby="delete-recording-title"
        aria-modal="true"
        className={cn(dialogSurfaceClassName, "w-[400px]")}
        role="alertdialog"
      >
        <DeleteRecordingMark />
        <div className={dialogHeaderClassName}>
          <h2 className={dialogTitleClassName} id="delete-recording-title">
            {DELETE_RECORDING.title}
          </h2>
          <p className={dialogDescriptionClassName} id="delete-recording-text">
            {DELETE_RECORDING.description}
          </p>
        </div>
        <DeleteRecordingKeeps />
        <div className={cn(dialogFooterClassName, DELETE_FOOTER_CLASS_NAME)}>
          <Button variant="secondary">Отмена</Button>
          <Button variant="destructive">Удалить запись</Button>
        </div>
      </div>
    </div>
  );
}
