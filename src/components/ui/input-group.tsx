"use client"

import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { useFieldControl } from "@/components/ui/field"

/*
 * A field box with addons (icons, buttons) next to the control. The states
 * live on the box, so `data-preview` on InputGroup pins hover and focus.
 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-10 w-full min-w-0 items-center gap-2 rounded-sm border border-input bg-background px-3 text-base text-foreground transition-[border-color,box-shadow,background-color] outline-none",
        "not-has-[[aria-invalid=true]]:hover:border-subtle not-has-[[aria-invalid=true]]:focus-within:field-focus",
        "has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:shadow-[0_0_0_3px_var(--color-contradiction-soft)]",
        "has-[[data-slot=input-group-control]:disabled]:pointer-events-none has-[[data-slot=input-group-control]:disabled]:border-border has-[[data-slot=input-group-control]:disabled]:bg-surface has-[[data-slot=input-group-control]:disabled]:text-subtle",
        "has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>textarea]:items-start",
        className
      )}
      {...props}
    />
  )
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 text-sm text-muted-foreground select-none group-has-[[data-slot=input-group-control]:disabled]/input-group:text-subtle [&>kbd]:rounded-xs [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first has-[>button]:-ml-1.5",
        "inline-end": "order-last has-[>button]:-mr-1.5",
        "block-start": "order-first w-full justify-start pt-2.5",
        "block-end": "order-last w-full justify-start pb-2.5",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  }
)

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus()
      }}
      {...props}
    />
  )
}

const inputGroupButtonVariants = cva("flex items-center gap-2 text-sm", {
  variants: {
    size: {
      xs: "h-6 gap-1 px-2 text-xs [&>svg:not([class*='size-'])]:size-3.5",
      sm: "h-7 px-2.5",
      "icon-xs": "size-6 p-0 [&>svg:not([class*='size-'])]:size-3.5",
      "icon-sm": "size-7 p-0",
    },
  },
  defaultVariants: {
    size: "xs",
  },
})

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset"
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  )
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  const fieldProps = useFieldControl(props)

  return (
    <InputPrimitive
      data-slot="input-group-control"
      className={cn(
        "h-full w-full min-w-0 flex-1 bg-transparent p-0 text-inherit caret-accent outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:placeholder:text-subtle",
        className
      )}
      {...props}
      {...fieldProps}
    />
  )
}

function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  const fieldProps = useFieldControl(props)

  return (
    <textarea
      data-slot="input-group-control"
      className={cn(
        "field-sizing-content min-h-20 w-full flex-1 resize-none bg-transparent py-2.5 text-inherit caret-accent outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:placeholder:text-subtle",
        className
      )}
      {...props}
      {...fieldProps}
    />
  )
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
}
