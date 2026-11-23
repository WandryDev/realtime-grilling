import { ClickUpIcon, GitHubIcon, OutlineIcon } from "@grill/ui/brand-icons";
import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";

import type { SourceKind } from "../mock";

/** A source of the brief: an integration, or a document from the computer. */
export type DocumentKind = SourceKind | "file";

/** The file mark, sized and colored like the brand marks. */
function FileMark({ className }: { className?: string }) {
  return (
    <FileTextIcon
      aria-hidden="true"
      className={cn("text-muted-foreground", className)}
      strokeWidth={1.75}
    />
  );
}

const SOURCE_ICON = {
  clickup: ClickUpIcon,
  file: FileMark,
  github: GitHubIcon,
  outline: OutlineIcon,
} as const;

export const SOURCE_NAME: Record<SourceKind, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

/** Brand mark of a source. Decorative, 14px unless sized at the call site. */
export function SourceMark({
  className,
  kind,
}: {
  className?: string;
  kind: DocumentKind;
}) {
  const Icon = SOURCE_ICON[kind];
  return <Icon className={cn("size-3.5", className)} />;
}

/**
 * Brand mark on a gray tile: 26px with a 14px mark in table rows, 32px with
 * a 16px mark in source blocks, 24px white tiles on gray cards.
 */
export function SourceTile({
  className,
  kind,
  label,
  size = "md",
}: {
  className?: string;
  kind: DocumentKind;
  /** Hover hint and spoken name; without it the tile is decorative. */
  label?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "bg-surface flex shrink-0 items-center justify-center",
        size === "sm" && "size-6 rounded-xs",
        size === "md" && "size-[26px] rounded-xs",
        size === "lg" && "size-8 rounded-xs",
        className
      )}
      title={label}
    >
      <SourceMark
        className={cn(
          size === "sm" && "size-[13px]",
          size === "lg" && "size-4"
        )}
        kind={kind}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
