"use client"

import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

import { useFieldControl } from "./field"

/*
 * Paper "02 Поля": 40 high, radius 12, hairline strong border. Hover darkens
 * the border, focus is an ink border with a soft halo, an error is red with a
 * red halo, disabled sits on the surface color. The caret is the orange accent.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const fieldProps = useFieldControl(props)

  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-base text-foreground caret-accent transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
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

export { Input }
