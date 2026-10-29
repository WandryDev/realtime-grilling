"use client"

import type * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

/*
 * Paper "04 Метки и пилюли", "Фильтр и вкладка": the selected item is a white
 * segment on a gray track, text 500. Tabs are 32px tall, filters (`sm`) 30px.
 * Black stays reserved for the topic anchor in a call.
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-stretch",
  {
    variants: {
      variant: {
        default: "gap-0.5 rounded-full bg-surface p-[3px]",
        line: "gap-1 bg-transparent",
      },
      size: {
        default: "",
        sm: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  size = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      data-size={size}
      className={cn(tabsListVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap text-foreground transition-colors outline-none select-none group-data-[size=sm]/tabs-list:h-[30px] group-data-vertical/tabs:justify-start [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=default]/tabs-list:not-data-active:not-data-disabled:hover:bg-border",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40",
        "group-data-[variant=default]/tabs-list:data-active:bg-background group-data-[variant=default]/tabs-list:data-active:shadow-touch",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:px-1 group-data-[variant=line]/tabs-list:text-muted-foreground group-data-[variant=line]/tabs-list:hover:text-foreground group-data-[variant=line]/tabs-list:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:-bottom-1 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

/**
 * Mono counter next to a tab or filter label. `accent` marks counts that
 * wait on the client, e.g. open questions.
 */
function TabsCount({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"span"> & { tone?: "default" | "accent" }) {
  return (
    <span
      data-slot="tabs-count"
      data-tone={tone}
      className={cn(
        "font-mono text-xs text-muted-foreground tabular-nums data-[tone=accent]:text-accent-ink",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-base outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsCount,
  TabsContent,
  tabsListVariants,
}
