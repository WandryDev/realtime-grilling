import { cn } from "cn"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemMeta,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

/*
 * Paper "08 Строки списков", "Интеграция": logo tile, name and description,
 * a 180px status column and a 150px action column. A hairline between rows
 * by default; `variant="plain"` drops it for lists spaced by their gap.
 * - connected: green dot, "подключено"; action "Настроить" (ghost)
 * - disconnected: no mark, "не подключено"; action "Подключить" (secondary)
 * - connecting: spinner, "жду подтверждения"; the description carries the
 *   OAuth device code (IntegrationCode); action "Отменить" (ghost)
 * - error: red dot, "ошибка", the reason in red; action "Обновить ключ"
 * The mark sits in a 12px lane so the status text lines up in every state.
 */
type IntegrationStatus = "connected" | "disconnected" | "connecting" | "error"

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: "подключено",
  disconnected: "не подключено",
  connecting: "жду подтверждения",
  error: "ошибка",
}

const STATUS_TEXT: Record<IntegrationStatus, string> = {
  connected: "text-confirmed",
  disconnected: "text-muted-foreground",
  connecting: "text-muted-foreground",
  error: "text-contradiction",
}

function IntegrationStatusMark({ status }: { status: IntegrationStatus }) {
  if (status === "connecting") {
    return (
      <Spinner
        aria-hidden
        aria-label={undefined}
        role={undefined}
        className="size-3 text-foreground"
      />
    )
  }
  if (status === "disconnected") {
    return null
  }
  return (
    <span
      data-slot="integration-row-dot"
      className={cn(
        "size-1.5 rounded-full",
        status === "connected" ? "bg-confirmed" : "bg-contradiction"
      )}
    />
  )
}

type IntegrationRowProps = Omit<React.ComponentProps<"div">, "title"> & {
  status: IntegrationStatus
  /** Brand mark, 18px inside the 32px tile. */
  icon: React.ReactNode
  name: React.ReactNode
  /** What it's used for, the device code, or the error reason. */
  description: React.ReactNode
  /** Overrides the status text. */
  statusLabel?: React.ReactNode
  /** Button for the 150px action column. */
  action?: React.ReactNode
  /** "divided" (default): hairline under the row; "plain": none. */
  variant?: "divided" | "plain"
}

function IntegrationRow({
  className,
  status,
  icon,
  name,
  description,
  statusLabel,
  action,
  variant = "divided",
  ...props
}: IntegrationRowProps) {
  return (
    <Item
      variant={variant}
      data-status={status}
      className={className}
      {...props}
    >
      <ItemMedia variant="tile">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription
          className={cn(status === "error" && "text-contradiction")}
        >
          {description}
        </ItemDescription>
      </ItemContent>
      <ItemMeta className={cn("w-[180px] text-sm", STATUS_TEXT[status])}>
        <span
          aria-hidden
          className="flex size-3 shrink-0 items-center justify-center"
        >
          <IntegrationStatusMark status={status} />
        </span>
        <span data-slot="integration-row-status">
          {statusLabel ?? STATUS_LABEL[status]}
        </span>
      </ItemMeta>
      <ItemActions className="w-[150px]">{action}</ItemActions>
    </Item>
  )
}

/**
 * One-time code in the description while connecting: mono 12/500, ink, 6px
 * after the text (put a space before it so screen readers don't glue words).
 */
function IntegrationCode({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      data-slot="integration-code"
      className={cn(
        "ml-0.5 font-mono text-xs font-medium text-foreground select-all",
        className
      )}
      {...props}
    />
  )
}

export { IntegrationCode, IntegrationRow }
export type { IntegrationRowProps, IntegrationStatus }
