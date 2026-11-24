import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Avatar } from "./avatar"

/*
 * Paper "06 Сообщения расшифровки", the Message pattern on the gray transcript
 * column (340 wide):
 *
 *   <Message>                       client: avatar on the left
 *     <MessageAvatar><AvatarFallback>К</AvatarFallback></MessageAvatar>
 *     <MessageContent>
 *       <MessageHeader>Клиент</MessageHeader>
 *       <Bubble variant="card">…</Bubble>
 *       <MessageFooter status="answered">ответ на вопрос</MessageFooter>
 *     </MessageContent>
 *   </Message>
 *
 * `align="end"` is you: no avatar, name and black bubbles on the right.
 * Consecutive phrases of one speaker are one Message with several Bubbles: the
 * name and avatar show once and only the last bubble gets a tail. The avatar
 * lines up with the last bubble, above the footer.
 */

/** The transcript list: 18px between turns. */
function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-[18px]", className)}
      {...props}
    />
  )
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn("group/message flex w-full min-w-0 gap-2", className)}
      {...props}
    />
  )
}

/**
 * The 26px speaker avatar. `speaking` adds the orange ring of whoever is
 * talking right now. Children are `AvatarImage` / `AvatarFallback`.
 */
function MessageAvatar({
  className,
  ...props
}: React.ComponentProps<typeof Avatar>) {
  return (
    <Avatar
      size="sm"
      className={cn(
        "self-end group-has-data-[slot=message-footer]/message:mb-6",
        className
      )}
      {...props}
    />
  )
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-start gap-1.5 group-data-[align=end]/message:items-end group-data-[align=end]/message:gap-1",
        className
      )}
      {...props}
    />
  )
}

/** Speaker name above the bubbles, 13px medium muted. */
function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex max-w-full min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/** "говорит" next to the name while the person is talking. */
function MessageSpeaking({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="message-speaking"
      className={cn("font-normal text-accent-ink", className)}
      {...props}
    >
      {children ?? "говорит"}
    </span>
  )
}

/**
 * Typing dots at the end of a bubble while speech is still being
 * transcribed. Decorative: pair it with MessageSpeaking.
 */
function MessageTyping({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="message-typing"
      className={cn(
        "flex gap-[3px] *:size-[5px] *:shrink-0 *:rounded-full *:bg-subtle",
        className
      )}
      {...props}
    >
      <span />
      <span className="opacity-60" />
      <span className="opacity-30" />
    </span>
  )
}

/*
 * What the agent made of the phrase: answered a question (green check),
 * contradicts something said earlier (red dot, usually with a time link),
 * an assumption worth checking (blue dot). Links and buttons inside inherit
 * the color and underline on hover.
 */
const messageFooterVariants = cva(
  "flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground [&_a,&_button]:rounded-xs [&_a,&_button]:underline-offset-2 [&_a,&_button]:outline-none [&_a,&_button]:hover:underline [&_a,&_button]:focus-visible:focus-ring",
  {
    variants: {
      status: {
        answered: "text-confirmed",
        contradiction: "text-contradiction",
        assumption: "text-assumption",
      },
    },
  }
)

function MessageFooterIndicator({
  status,
}: {
  status: NonNullable<VariantProps<typeof messageFooterVariants>["status"]>
}) {
  if (status === "answered") {
    return (
      <svg
        aria-hidden
        data-slot="message-footer-icon"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3 shrink-0"
      >
        <path d="M3 7.5L5.8 10L11 4" />
      </svg>
    )
  }
  return (
    <span
      aria-hidden
      data-slot="message-footer-dot"
      className="size-1.5 shrink-0 rounded-full bg-current"
    />
  )
}

function MessageFooter({
  className,
  status,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof messageFooterVariants>) {
  return (
    <div
      data-slot="message-footer"
      data-status={status ?? undefined}
      className={cn(messageFooterVariants({ status }), className)}
      {...props}
    >
      {status ? <MessageFooterIndicator status={status} /> : null}
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageSpeaking,
  MessageTyping,
  messageFooterVariants,
}
