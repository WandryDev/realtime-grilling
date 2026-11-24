"use client"

import { cn } from "cn"

import {
  PersonChip,
  PersonChipAdd,
  type PersonChipProps,
} from "./person-chip"
import { SelectTrigger } from "./select"

/*
 * Paper "10 Окна и оболочки", "Плавающий виджет": a 320px white card with a
 * 26px radius and the float shadow. It pops up in the top right corner, over
 * the meeting app, when a call seems to start: title, the app that holds the
 * microphone, project select, participants, "Начать" and "Не сейчас".
 *
 *   <CallWidget>
 *     <CallWidgetHeader>
 *       <CallWidgetTitle>Похоже, начался звонок</CallWidgetTitle>
 *       <CallWidgetDescription><ZoomIcon /> Микрофон занят Zoom</CallWidgetDescription>
 *     </CallWidgetHeader>
 *     <CallWidgetContent>
 *       <Select …><CallWidgetSelectTrigger>…</CallWidgetSelectTrigger>…</Select>
 *       <CallWidgetPeople>
 *         <CallWidgetPerson name="Ольга" initials="ОД" />
 *         <CallWidgetAddPerson />
 *       </CallWidgetPeople>
 *     </CallWidgetContent>
 *     <CallWidgetFooter>
 *       <Button size="lg" className="flex-1">Начать</Button>
 *       <Button size="lg" variant="ghost">Не сейчас</Button>
 *     </CallWidgetFooter>
 *   </CallWidget>
 */
function CallWidget({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget"
      className={cn(
        "flex w-full max-w-widget flex-col gap-4 rounded-lg bg-background p-[18px] text-foreground shadow-float",
        className
      )}
      {...props}
    />
  )
}

function CallWidgetHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  )
}

function CallWidgetTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  )
}

/** Muted 13px line with a 12px app mark before it. */
function CallWidgetDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-description"
      className={cn(
        "flex items-center gap-1.5 text-sm text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function CallWidgetContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-content"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function CallWidgetFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-footer"
      className={cn("flex gap-2", className)}
      {...props}
    />
  )
}

/*
 * The project picker in the widget is a borderless gray field, 36 high, with
 * the project name in medium weight. Use it inside a regular <Select>.
 */
function CallWidgetSelectTrigger({
  className,
  ...props
}: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(
        "border-transparent bg-surface font-medium data-[size=default]:h-9 not-aria-invalid:hover:border-transparent not-aria-invalid:hover:bg-border [&_svg]:size-3.5",
        className
      )}
      {...props}
    />
  )
}

/*
 * Participants: the shared PersonChip from "08 Строки списков", one step
 * smaller in the widget (28px pill, 24px avatar), and an icon-only 28px
 * circle to add someone.
 */
function CallWidgetPeople({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="call-widget-people"
      className={cn("flex flex-wrap gap-1.5", className)}
      {...props}
    />
  )
}

function CallWidgetPerson({ className, ...props }: PersonChipProps) {
  return (
    <PersonChip
      className={cn(
        "h-7 gap-1.5 pr-2.5 pl-[3px] [&>[data-slot=avatar][data-size=sm]]:size-6",
        className
      )}
      {...props}
    />
  )
}

function CallWidgetAddPerson({
  className,
  "aria-label": ariaLabel = "Добавить участника",
  ...props
}: Omit<React.ComponentProps<typeof PersonChipAdd>, "children">) {
  return (
    <PersonChipAdd
      aria-label={ariaLabel}
      className={cn("size-7 justify-center px-0", className)}
      {...props}
    >
      {null}
    </PersonChipAdd>
  )
}

export {
  CallWidget,
  CallWidgetAddPerson,
  CallWidgetContent,
  CallWidgetDescription,
  CallWidgetFooter,
  CallWidgetHeader,
  CallWidgetPeople,
  CallWidgetPerson,
  CallWidgetSelectTrigger,
  CallWidgetTitle,
}
