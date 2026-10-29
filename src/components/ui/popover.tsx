"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"

/*
 * Paper "09 Обратная связь", "Поповер": opens on a click on a label. A 320
 * wide white card, radius 26, float shadow, 16px padding, 12px rhythm. Title
 * 14/600, muted 13px explanation, then a quote (PopoverQuote: mono time over
 * the phrase, gray rule on the left) and small gray actions.
 *
 * popoverSurfaceClassName is shared with the static preview in /dev.
 */

const popoverSurfaceClassName =
  "flex w-80 flex-col gap-3 rounded-lg bg-popover p-4 text-sm text-popover-foreground shadow-float"

const popoverTitleClassName = "text-base font-semibold text-foreground"

const popoverDescriptionClassName = "text-sm text-muted-foreground"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 8,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            popoverSurfaceClassName,
            "z-50 origin-(--transform-origin) outline-hidden duration-100 ease-out data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn(popoverTitleClassName, className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn(popoverDescriptionClassName, className)}
      {...props}
    />
  )
}

/** A quoted phrase from the call: mono time over the text, gray rule left. */
function PopoverQuote({
  className,
  time,
  children,
  ...props
}: React.ComponentProps<"figure"> & {
  /** Moment of the call, already formatted: "12:23". */
  time?: React.ReactNode
}) {
  return (
    <figure
      data-slot="popover-quote"
      className={cn("flex gap-2.5", className)}
      {...props}
    >
      <span
        aria-hidden
        className="w-0.5 shrink-0 rounded-full bg-border-strong"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {time ? (
          <figcaption className="font-mono text-xs text-muted-foreground tabular-nums">
            {time}
          </figcaption>
        ) : null}
        <blockquote className="text-sm text-foreground">{children}</blockquote>
      </div>
    </figure>
  )
}

function PopoverFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-footer"
      className={cn("flex flex-wrap gap-1.5", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverFooter,
  PopoverHeader,
  PopoverQuote,
  PopoverTitle,
  PopoverTrigger,
  popoverDescriptionClassName,
  popoverSurfaceClassName,
  popoverTitleClassName,
}
