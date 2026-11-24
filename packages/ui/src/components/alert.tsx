import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "09 Обратная связь", "Баннер в панели": a radius 18 strip inside a
 * panel. A 16px icon, a 14/500 title over a 13px line, an action on the
 * right. The action is a white pill (h 28) on the tinted fill.
 * - default: gray, for information ("ClickUp не подключён")
 * - warning: soft orange, all text in accent-ink
 * - destructive: soft red, red title and icon, muted text
 *
 *   <Alert variant="warning">
 *     <CircleAlertIcon />
 *     <AlertTitle>…</AlertTitle>
 *     <AlertDescription>…</AlertDescription>
 *     <AlertAction><Button size="sm" variant="secondary">…</Button></AlertAction>
 *   </Alert>
 *
 * Errors are announced (role="alert"); the calmer banners are a status.
 */
const alertVariants = cva(
  "group/alert relative grid w-full grid-cols-[1fr] items-center gap-x-3 rounded-md py-3.5 pr-3.5 pl-[18px] text-left has-[>svg]:grid-cols-[auto_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto] *:[svg]:col-start-1 *:[svg]:row-span-2 *:[svg]:row-start-1 *:[svg]:shrink-0 *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-surface text-foreground *:[svg]:text-muted-foreground",
        warning:
          "bg-accent-soft text-accent-ink *:data-[slot=alert-description]:text-accent-ink *:[svg]:text-accent-ink",
        destructive:
          "bg-contradiction-soft text-contradiction *:[svg]:text-contradiction",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-1 min-w-0 text-base font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-1 min-w-0 text-sm text-pretty text-muted-foreground group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-2",
        className
      )}
      {...props}
    />
  )
}

/* White pill on the tint. Hover lets a little of the tint through. */
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 group-has-[>svg]/alert:col-start-3",
        "*:data-[slot=button]:bg-background *:data-[slot=button]:text-foreground *:data-[slot=button]:hover:bg-background/70 *:data-[slot=button]:active:bg-background/50",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants }
