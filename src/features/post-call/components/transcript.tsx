"use client";

/*
 * "06 Детали звонка": the full transcript with topic anchors, the pinned
 * audio player, the questions of the call on the right and the dialog that
 * deletes the recording. Client module: the static dialog reuses the class
 * constants of alert-dialog.tsx.
 */

import { type ReactNode, type RefObject, useCallback } from "react";

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
import { SideCard, SideHeading } from "./call-window";
import { DoneCheck, OpenRing, StatusDot } from "./status-mark";

/** One phrase: the client on the left in white, you on the right in ink. */
export function TranscriptTurn({
  className,
  turn,
}: {
  className?: string;
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
      className={className}
      data-turn-id={turn.id}
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
          {turn.text}
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
const WAVE_STEP = 6;
const PERCENT = 100;

/** Recorded waveform: played bars in ink, the rest gray, a playhead. */
export function Waveform({
  className,
  progress,
}: {
  className?: string;
  /** Played share, 0 to 1. */
  progress: number;
}) {
  const playedWidth = progress * WAVE_WIDTH;

  return (
    <div
      aria-hidden="true"
      className={cn("relative flex h-7 min-w-0 flex-1 items-center", className)}
    >
      <svg
        aria-hidden="true"
        className="h-7 w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${WAVE_WIDTH} 28`}
      >
        {WAVEFORM.map(([y, height], index) => {
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
              width="4"
              x={x}
              y={y}
            />
          );
        })}
      </svg>
      <span
        className="bg-foreground absolute top-0 h-7 w-0.5 rounded-[1px]"
        style={{ left: `${(progress * PERCENT).toFixed(1)}%` }}
      />
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

/** Channel picker of the player: a static button in /dev, a menu in the app. */
function ChannelButton({
  channel,
  onChannelChange,
}: {
  channel: PlayerChannel;
  onChannelChange?: (channel: PlayerChannel) => void;
}) {
  const change = useCallback(
    (value: unknown) => {
      const next = PLAYER_CHANNELS.find((item) => item.id === value);
      if (next) {
        onChannelChange?.(next.id);
      }
    },
    [onChannelChange]
  );
  const label =
    PLAYER_CHANNELS.find((item) => item.id === channel)?.label ?? "";
  const button = (
    <Button
      className="h-7 gap-1.5 px-2.5 font-normal"
      size="sm"
      variant="secondary"
    >
      {label}
      <ChevronDownIcon className="text-muted-foreground size-2.5" />
    </Button>
  );

  if (!onChannelChange) {
    return button;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={button} />
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuRadioGroup onValueChange={change} value={channel}>
          {PLAYER_CHANNELS.map((item) => (
            <DropdownMenuRadioItem closeOnClick key={item.id} value={item.id}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Player pinned to the bottom of the panel. */
export function AudioPlayer({
  channel = "both",
  className,
  duration,
  onChannelChange,
  onSpeedChange,
  onTogglePlay,
  playing = true,
  position,
  speed = RECORDING.speed as PlayerSpeed,
}: {
  channel?: PlayerChannel;
  className?: string;
  duration: string;
  onChannelChange?: (channel: PlayerChannel) => void;
  onSpeedChange?: (speed: PlayerSpeed) => void;
  onTogglePlay?: () => void;
  playing?: boolean;
  position: string;
  speed?: PlayerSpeed;
}) {
  const progress = Math.min(toSeconds(position) / toSeconds(duration), 1);
  const nextSpeed = useCallback(() => {
    const index = PLAYER_SPEEDS.indexOf(speed);
    onSpeedChange?.(PLAYER_SPEEDS[(index + 1) % PLAYER_SPEEDS.length] ?? "1×");
  }, [onSpeedChange, speed]);

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
      <Waveform progress={progress} />
      <Button
        aria-label={`Скорость ${speed}`}
        className="h-7 px-2.5 font-mono text-xs font-normal"
        onClick={onSpeedChange ? nextSpeed : undefined}
        size="sm"
        variant="secondary"
      >
        {speed}
      </Button>
      <ChannelButton channel={channel} onChannelChange={onChannelChange} />
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
  onDelete,
}: {
  className?: string;
  /** The audio is gone; transcript and moments still work. */
  deleted?: boolean;
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
      <p className="text-muted-foreground text-sm">{RECORDING.description}</p>
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
  onConfirm,
  onOpenChange,
  open,
}: {
  cancelRef: RefObject<HTMLButtonElement | null>;
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
          <AlertDialogDescription>
            {DELETE_RECORDING.description}
          </AlertDialogDescription>
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
        "bg-foreground/24 absolute inset-0 z-10 flex items-center justify-center",
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
