import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { CodeIcon } from "lucide-react"
import { cn } from "cn"

import {
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons"

/*
 * Paper "04 Метки и пилюли", "Источник вопроса": a 26px gray pill with a 12px
 * mark and muted 13px text. With `taskId` it becomes a task link, the id in
 * JetBrains Mono (CU-517). Pass `render={<a href="…" />}` to make it a link.
 */
const SOURCES = {
  code: { icon: CodeIcon, label: "из кода" },
  clickup: { icon: ClickUpIcon, label: "ClickUp" },
  outline: { icon: OutlineIcon, label: "Outline" },
  github: { icon: GitHubIcon, label: "GitHub" },
} as const

type QuestionSource = keyof typeof SOURCES

type SourceBadgeProps = useRender.ComponentProps<"span"> & {
  source: QuestionSource
  /** Task id shown instead of the source name, e.g. "CU-517". */
  taskId?: string
}

function SourceBadge({
  className,
  source,
  taskId,
  render,
  children,
  ...props
}: SourceBadgeProps) {
  const { icon: Icon, label } = SOURCES[source]
  const isCode = source === "code"

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          "inline-flex h-[26px] w-fit shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:focus-ring [a]:hover:bg-border [a]:active:bg-border-strong",
          className
        ),
        children: (
          <>
            <Icon
              aria-hidden
              data-slot="source-badge-icon"
              className="size-3 shrink-0"
              {...(isCode ? { strokeWidth: 2.4 } : {})}
            />
            {taskId ? (
              <span className="font-mono text-xs">{taskId}</span>
            ) : (
              (children ?? label)
            )}
          </>
        ),
      },
      props
    ),
    render,
    state: {
      slot: "source-badge",
      source,
    },
  })
}

export { SourceBadge }
export type { QuestionSource, SourceBadgeProps }
