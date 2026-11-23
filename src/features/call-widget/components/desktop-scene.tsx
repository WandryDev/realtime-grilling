import { ZoomIcon } from "@grill/ui/brand-icons";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * A stand-in macOS desktop from the Paper "Звонок" scenes: menu bar, gray
 * desktop and a Zoom window. Not product UI, only the backdrop for the
 * floating widgets: the /dev previews and, in the browser, the /widget and
 * /overlay routes (in Tauri those are transparent windows over the real
 * desktop). The gray stand-in colors come from Paper and are not design
 * tokens; the dark theme gets a dark desktop of the same kind.
 */

function AppleLogo() {
  return (
    <svg
      aria-hidden="true"
      className="size-[13px] shrink-0 opacity-85"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

function MenuBar({ clock, micInUse }: { clock: string; micInUse: boolean }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between bg-white/45 px-4 text-sm dark:bg-black/35">
      <div className="flex items-center gap-[18px]">
        <AppleLogo />
        <span className="font-semibold">zoom.us</span>
        <span className="text-muted-foreground">Встреча</span>
        <span className="text-muted-foreground">Окно</span>
      </div>
      <div className="flex items-center gap-3.5">
        {micInUse ? (
          <span className="bg-accent size-[7px] shrink-0 rounded-full" />
        ) : null}
        <span>{clock}</span>
      </div>
    </div>
  );
}

const PEOPLE = [
  { initials: "ОД", name: "Ольга Демченко" },
  { initials: "ИС", name: "Игорь Савчук" },
];

function VideoTile({ initials, name }: { initials: string; name: string }) {
  return (
    <div className="relative flex flex-1 basis-0 flex-col items-center justify-center rounded-[10px] bg-[#C6C6C3] dark:bg-[#34322f]">
      <span className="flex size-14 items-center justify-center rounded-full bg-[#B5B5B2] text-xl font-medium text-white dark:bg-[#4a4743]">
        {initials}
      </span>
      <span className="absolute bottom-2 left-2.5 text-xs text-white">
        {name}
      </span>
    </div>
  );
}

function MeetingEnded() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[10px] bg-[#C6C6C3] dark:bg-[#34322f]">
      <span className="text-lg font-medium text-white">Встреча завершена</span>
      <span className="text-sm text-white/80">
        Организатор завершил встречу для всех
      </span>
    </div>
  );
}

/*
 * Browser stand-in for "the meeting app let go of the microphone": the
 * red "Выйти" in Zoom's toolbar. Only rendered when the scene is
 * interactive.
 */
function LeaveMeetingButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="focus-visible:focus-ring absolute right-3 rounded-full bg-[#E5484D] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
      onClick={onClick}
      type="button"
    >
      Выйти из встречи
    </button>
  );
}

function ZoomWindow({
  ended,
  onLeave,
  sharing,
}: {
  ended: boolean;
  onLeave?: () => void;
  sharing: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute top-16 left-10 flex h-[400px] flex-col overflow-clip rounded-[14px] bg-[#D4D4D1] shadow-[0_0_0_1px_rgb(17_17_17/5%),0_12px_40px_rgb(17_17_17/8%)] dark:bg-[#262422] dark:shadow-[0_0_0_1px_rgb(255_255_255/8%),0_12px_40px_rgb(0_0_0/40%)]",
        sharing ? "w-[500px]" : "w-[540px]"
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between px-3.5">
        <div className="flex gap-[7px] *:size-[11px] *:rounded-full *:bg-[#C2C2BF] dark:*:bg-[#4a4743]">
          <span />
          <span />
          <span />
        </div>
        <span className="text-muted-foreground text-xs">
          {sharing ? "Вы показываете экран" : "Zoom Meeting"}
        </span>
        <span className="w-[47px] shrink-0" />
      </div>
      <div className="flex flex-1 gap-1.5 px-1.5 pb-1.5">
        {ended ? (
          <MeetingEnded />
        ) : (
          PEOPLE.map((person) => <VideoTile key={person.name} {...person} />)
        )}
      </div>
      <div className="relative flex h-12 shrink-0 items-center justify-center gap-2">
        <ZoomIcon className="size-11" />
        <span className="text-muted-foreground text-sm font-medium">Zoom</span>
        {onLeave && !ended ? <LeaveMeetingButton onClick={onLeave} /> : null}
      </div>
    </div>
  );
}

/**
 * The 960×600 desktop. `children` is Grill's floating UI, pinned 44px from
 * the top and 16px from the right as in every scene.
 */
export function DesktopScene({
  children,
  className,
  clock,
  meetingEnded = false,
  micInUse = true,
  onLeaveMeeting,
  sharing = false,
}: {
  children: ReactNode;
  className?: string;
  /** Menu bar clock: "Пн 12:00". */
  clock: string;
  /** Zoom shows "Встреча завершена" instead of the video tiles. */
  meetingEnded?: boolean;
  /** Orange microphone dot in the menu bar. */
  micInUse?: boolean;
  /** Adds "Выйти из встречи" to Zoom, so the browser can simulate it. */
  onLeaveMeeting?: () => void;
  /** Zoom is sharing the screen: narrower window, "Вы показываете экран". */
  sharing?: boolean;
}) {
  return (
    <div
      className={cn(
        "text-foreground relative flex flex-col overflow-clip bg-[#E4E4E1] dark:bg-[#0f0e0d]",
        className
      )}
    >
      <MenuBar clock={clock} micInUse={micInUse} />
      <ZoomWindow
        ended={meetingEnded}
        onLeave={onLeaveMeeting}
        sharing={sharing}
      />
      <div className="absolute top-11 right-4">{children}</div>
    </div>
  );
}
