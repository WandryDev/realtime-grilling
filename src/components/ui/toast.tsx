"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { cn } from "cn"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/*
 * Paper "09 Обратная связь", "Тост": a white pill card (radius 26, float
 * shadow) with a 24px status circle, one line of 14px text, an optional
 * action and a close cross.
 * - success: green check, a quiet text action ("Вернуть"), no cross; it
 *   leaves on its own after the timeout
 * - error: red "!", a gray action ("Повторить") and a cross
 * - info: gray "i" and a cross
 * Toasts live in a polite live region (Base UI Viewport); `priority: "high"`
 * makes one announce assertively.
 *
 * The class constants below are shared with static previews in /dev, which
 * draw a toast in place without the provider.
 */

const toast = ToastPrimitive.createToastManager()

const toastSurfaceClassName =
  "rounded-lg bg-popover text-popover-foreground shadow-float"

/* Next to an action the cross tucks in 4px on each side, as in Paper */
const toastContentClassName =
  "flex items-center gap-3 py-3 pr-3 pl-4 has-data-[slot=toast-action]:has-data-[slot=toast-close]:gap-2.5 [&:has([data-slot=toast-action])>[data-slot=toast-close]]:-mx-1"

const toastTitleClassName = "min-w-0 flex-1 text-base text-foreground"

/* Quiet text action for success ("Вернуть"), gray pill for errors */
const toastActionClassName = "shrink-0 px-3"

/* 28px cross with a 12px glyph */
const toastCloseClassName =
  "shrink-0 text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-3"

type ToastType = "success" | "error" | "info" | "warning" | "loading"

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-overlay outline-none sm:right-6 sm:bottom-6 sm:left-auto sm:mx-0 sm:w-overlay",
        className
      )}
      {...props}
    />
  )
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        toastSurfaceClassName,
        "group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom will-change-transform outline-none select-none focus-visible:focus-ring",
        "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.05)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_200ms_cubic-bezier(0.22,1,0.36,1),opacity_200ms,height_150ms] motion-reduce:[transition:opacity_150ms]",
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-ending-style:opacity-0 data-limited:opacity-0 data-starting-style:opacity-0 data-starting-style:[transform:translateY(100%)] motion-reduce:data-starting-style:[transform:none]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(100%)] motion-reduce:[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:none]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        toastContentClassName,
        "h-full overflow-hidden transition-opacity duration-200 ease-out data-behind:opacity-0 data-expanded:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-base text-foreground", className)}
      {...props}
    />
  )
}

function ToastDescription({
  className,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function ToastAction({
  className,
  variant = "ghost",
  render = <Button variant={variant} size="sm" />,
  ...props
}: ToastPrimitive.Action.Props & {
  /** `ghost` for undo on success, `secondary` for retry on errors. */
  variant?: "ghost" | "secondary"
}) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn(toastActionClassName, className)}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Закрыть"
      render={render}
      className={cn(toastCloseClassName, className)}
      {...props}
    >
      {children ?? <XIcon aria-hidden strokeWidth={2.4} />}
    </ToastPrimitive.Close>
  )
}

/* Glyphs from Paper, drawn at 12px inside the 24px circle */
function SuccessGlyph() {
  return (
    <svg viewBox="0 0 14 14" fill="none" className="size-3">
      <path
        d="M3 7.5L5.8 10L11 4"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExclamationGlyph() {
  return (
    <svg viewBox="0 0 12 12" fill="none" className="size-3">
      <path
        d="M6 3V6.5"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <circle cx="6" cy="9" r="0.9" fill="currentColor" />
    </svg>
  )
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 12 12" fill="none" className="size-3">
      <circle cx="6" cy="3.2" r="0.9" fill="currentColor" />
      <path
        d="M6 5.5V9"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </svg>
  )
}

const TOAST_ICON_TONE: Record<ToastType, string> = {
  success: "bg-confirmed-soft text-confirmed",
  error: "bg-contradiction-soft text-contradiction",
  warning: "bg-accent-soft text-accent-ink",
  info: "bg-surface text-muted-foreground",
  loading: "bg-surface text-foreground",
}

function isToastType(type: string | undefined): type is ToastType {
  return type !== undefined && type in TOAST_ICON_TONE
}

/** The 24px status circle. Renders nothing for an unknown type. */
function ToastIcon({
  className,
  type,
  ...props
}: React.ComponentProps<"span"> & { type: string | undefined }) {
  if (!isToastType(type)) {
    return null
  }

  let glyph: React.ReactNode = <InfoGlyph />
  if (type === "success") {
    glyph = <SuccessGlyph />
  } else if (type === "error" || type === "warning") {
    glyph = <ExclamationGlyph />
  } else if (type === "loading") {
    glyph = (
      <Spinner
        aria-hidden
        aria-label={undefined}
        role={undefined}
        className="size-3"
      />
    )
  }

  return (
    <span
      aria-hidden
      data-slot="toast-icon"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full",
        TOAST_ICON_TONE[type],
        className
      )}
      {...props}
    >
      {glyph}
    </span>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toastItem) => {
    const hasAction = Boolean(toastItem.actionProps?.children)
    // Errors stay until dismissed, so they always get a cross; an undo toast
    // times out on its own and keeps only its action.
    const showClose = !hasAction || toastItem.type === "error"

    return (
      <Toast key={toastItem.id} toast={toastItem}>
        <ToastContent>
          <ToastIcon type={toastItem.type} />
          <div className="flex min-w-0 flex-1 flex-col">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastAction
            variant={toastItem.type === "error" ? "secondary" : "ghost"}
          />
          {showClose ? <ToastClose /> : null}
        </ToastContent>
      </Toast>
    )
  })
}

function Toaster({
  children,
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const createToastManager = ToastPrimitive.createToastManager
const useToastManager = ToastPrimitive.useToastManager

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastIcon,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  toastActionClassName,
  toastCloseClassName,
  toastContentClassName,
  toastSurfaceClassName,
  toastTitleClassName,
  useToastManager,
}
export type { ToastType }
