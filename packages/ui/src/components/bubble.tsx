import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "06 Сообщения расшифровки", the speech bubble: 18px corners, 10/14
 * padding, 14px text. `card` is the client (white with the touch shadow on the
 * gray column), `default` is you (ink with white text).
 *
 * The tail (a 6px corner) sits on the last bubble of a message only, so
 * consecutive bubbles read as one turn. It points to the speaker: bottom-left
 * in a start-aligned Message, bottom-right in an end-aligned one. Outside a
 * Message a bubble has no tail.
 */
const bubbleVariants = cva(
  [
    "flex w-fit max-w-full min-w-0 flex-col gap-1.5 rounded-[18px] px-3.5 py-2.5 text-base wrap-break-word",
    // Leave room on the far side, as wide as the avatar column
    "group-data-[align=end]/message:max-w-[calc(100%-34px)]",
    // Tail on the last bubble: no later bubble sibling
    "group-data-[align=start]/message:[&:not(:has(~[data-slot=bubble]))]:rounded-bl-[6px]",
    "group-data-[align=end]/message:[&:not(:has(~[data-slot=bubble]))]:rounded-br-[6px]",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        card: "bg-background text-foreground shadow-touch",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Bubble({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof bubbleVariants>) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Bubble, bubbleVariants }
