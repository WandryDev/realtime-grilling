import { cva } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "10 Окна и оболочки", "Шапка окна, macOS" and "Шапка окна, Windows".
 *
 * The app draws its own window chrome. The bar is 56px high and sits on the
 * window's surface fill: project and participants on the left, the recording
 * chip and a single black button on the right. On Windows the system buttons
 * (46×56, thin line icons) close the bar flush to the right edge.
 *
 * The whole bar is a Tauri drag region (`deep`: any non-interactive child
 * drags the window, buttons and links still get their clicks). Dragging needs
 * the `core:window:allow-start-dragging` permission in the capability.
 *
 * Nothing here talks to Tauri directly so the components render in a browser
 * too: the window controls take callbacks, the app wires them to
 * `getCurrentWindow().minimize()` etc.
 *
 *   <WindowTitlebar>
 *     <WindowTitlebarStart>
 *       <WindowTrafficLights />
 *       <WindowTitle>
 *         Телемедиа <WindowSubtitle>с Ольгой и Игорем</WindowSubtitle>
 *       </WindowTitle>
 *     </WindowTitlebarStart>
 *     <WindowTitlebarEnd>
 *       <RecordingIndicator time="24:18" />
 *       <Button>Завершить</Button>
 *       <WindowControls onMinimize={…} onMaximize={…} onClose={…} />
 *     </WindowTitlebarEnd>
 *   </WindowTitlebar>
 */
function WindowTitlebar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-titlebar"
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-14 shrink-0 items-center justify-between gap-5 px-5 select-none",
        // Windows: the system buttons touch the right edge
        "has-data-[slot=window-controls]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function WindowTitlebarStart({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-titlebar-start"
      className={cn("flex min-w-0 items-center gap-5", className)}
      {...props}
    />
  )
}

function WindowTitlebarEnd({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-titlebar-end"
      className={cn(
        "flex h-full shrink-0 items-center justify-end gap-2 *:data-[slot=window-controls]:ml-3",
        className
      )}
      {...props}
    />
  )
}

/** Project name, semibold. Put the participants in a WindowSubtitle inside. */
function WindowTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-title"
      className={cn(
        "flex min-w-0 items-center gap-2 text-base font-semibold whitespace-nowrap text-foreground",
        className
      )}
      {...props}
    />
  )
}

function WindowSubtitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="window-subtitle"
      className={cn("truncate font-normal text-muted-foreground", className)}
      {...props}
    />
  )
}

/*
 * macOS traffic lights. In the design they are always gray (#DCDCDA), the
 * same in every window state. They are decorative: in the Tauri build the
 * window uses an overlay title bar and macOS draws the real, clickable
 * controls on top of this spot, so this only reserves their space and stands
 * in for them in the browser and in /dev.
 */
function WindowTrafficLights({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-traffic-lights"
      aria-hidden
      className={cn(
        "flex shrink-0 gap-2 *:size-3 *:rounded-full *:bg-traffic-light",
        className
      )}
      {...props}
    >
      <span />
      <span />
      <span />
    </div>
  )
}

const WINDOW_CONTROLS = {
  minimize: {
    label: "Свернуть",
    icon: <path d="M1.5 6H10.5" strokeLinecap="round" />,
  },
  maximize: {
    label: "Развернуть",
    icon: <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />,
  },
  close: {
    label: "Закрыть",
    icon: <path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5" strokeLinecap="round" />,
  },
} as const

type WindowControlKind = keyof typeof WINDOW_CONTROLS

const windowControlVariants = cva(
  "flex h-14 w-[46px] shrink-0 items-center justify-center text-foreground transition-colors outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)]",
  {
    variants: {
      control: {
        minimize: "hover:bg-border active:bg-border-strong",
        maximize: "hover:bg-border active:bg-border-strong",
        close:
          "hover:bg-destructive hover:text-on-ink active:bg-destructive-active active:text-on-ink",
      },
    },
  }
)

/*
 * One Windows system button: 46×56, a 12px icon drawn with 1px lines.
 * Hover is the hairline gray, on close it turns red with a white icon. The
 * focus ring is drawn inside, the button sits on the window edge.
 */
function WindowControl({
  className,
  control,
  type = "button",
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<"button"> & { control: WindowControlKind }) {
  const { icon, label } = WINDOW_CONTROLS[control]

  return (
    <button
      data-slot="window-control"
      data-control={control}
      type={type}
      aria-label={ariaLabel ?? label}
      className={cn(windowControlVariants({ control }), className)}
      {...props}
    >
      <svg
        aria-hidden
        focusable={false}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        className="shrink-0"
      >
        {icon}
      </svg>
    </button>
  )
}

/** Row of WindowControl buttons. Use it to compose the buttons yourself. */
function WindowControlGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="window-controls"
      role="group"
      aria-label="Управление окном"
      className={cn("flex h-14 shrink-0", className)}
      {...props}
    />
  )
}

type WindowControlsProps = Omit<
  React.ComponentProps<"div">,
  "children" | "onClose"
> & {
  onMinimize?: () => void
  onMaximize?: () => void
  onClose?: () => void
}

/** Windows system buttons: minimize, maximize, close. */
function WindowControls({
  onMinimize,
  onMaximize,
  onClose,
  ...props
}: WindowControlsProps) {
  return (
    <WindowControlGroup {...props}>
      <WindowControl control="minimize" onClick={onMinimize} />
      <WindowControl control="maximize" onClick={onMaximize} />
      <WindowControl control="close" onClick={onClose} />
    </WindowControlGroup>
  )
}

export {
  WindowControl,
  WindowControlGroup,
  WindowControls,
  WindowSubtitle,
  WindowTitle,
  WindowTitlebar,
  WindowTitlebarEnd,
  WindowTitlebarStart,
  WindowTrafficLights,
}
export type { WindowControlKind, WindowControlsProps }
