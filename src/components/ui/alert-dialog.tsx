"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { cn } from "cn"

import { Button } from "@/components/ui/button"

/*
 * Paper "09 Обратная связь", "Диалог": confirmation of a dangerous action.
 * A 420 wide white card, radius 26, float shadow, 24px padding over a 16%
 * ink backdrop. Title 20/600 tight, muted 14px text, then two 36px pills on
 * the right: gray "Отмена" (AlertDialogCancel) and red "Удалить"
 * (AlertDialogAction variant="destructive").
 *
 * The class constants are shared with dialog.tsx and with the static preview
 * in /dev.
 */

const dialogBackdropClassName =
  "fixed inset-0 isolate z-50 bg-foreground/16 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"

/* Look only: background, radius, shadow, padding and rhythm */
const dialogSurfaceClassName =
  "flex flex-col gap-5 rounded-lg bg-popover p-6 text-popover-foreground shadow-float"

/* Placement and motion of the live popup */
const dialogPopupClassName =
  "fixed top-1/2 left-1/2 z-50 w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 outline-none sm:max-w-[420px] duration-150 ease-out data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:data-open:zoom-in-100 motion-reduce:data-closed:zoom-out-100"

const dialogHeaderClassName = "flex flex-col gap-2"

const dialogTitleClassName =
  "text-xl font-semibold tracking-tight text-balance text-foreground"

const dialogDescriptionClassName =
  "text-base text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground"

/* Dialog buttons are 36 high with 14px labels */
const dialogFooterClassName =
  "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end [&>button]:h-9 [&>button]:px-4 [&>button]:text-base"

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(dialogBackdropClassName, className)}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm"
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          dialogSurfaceClassName,
          dialogPopupClassName,
          "group/alert-dialog-content data-[size=sm]:sm:max-w-xs",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(dialogHeaderClassName, className)}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        dialogFooterClassName,
        "group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "inline-flex size-12 items-center justify-center rounded-sm bg-surface text-muted-foreground *:[svg:not([class*='size-'])]:size-[22px]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(dialogTitleClassName, className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(dialogDescriptionClassName, className)}
      {...props}
    />
  )
}

/* The confirming button. It does not close the dialog: do the work in
 * onClick, then close it through a controlled `open`. */
function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="alert-dialog-action"
      className={cn(className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  variant = "secondary",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
  dialogBackdropClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogPopupClassName,
  dialogSurfaceClassName,
  dialogTitleClassName,
}
