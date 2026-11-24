"use client"

import * as React from "react"
import { cn } from "cn"

import { useFieldControl } from "./field"

/* Paper "02 Поля", Заметка: same box as Input, at least 88 high, grows with text. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const fieldProps = useFieldControl(props)

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-22 w-full resize-none rounded-sm border border-input bg-background px-3 py-2.5 text-base text-foreground caret-accent transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground",
        "not-aria-invalid:hover:border-subtle not-aria-invalid:focus-visible:field-focus",
        "aria-invalid:border-destructive aria-invalid:shadow-[0_0_0_3px_var(--color-contradiction-soft)]",
        "disabled:pointer-events-none disabled:border-border disabled:bg-surface disabled:text-subtle disabled:placeholder:text-subtle",
        className
      )}
      {...props}
      {...fieldProps}
    />
  )
}

export { Textarea }
