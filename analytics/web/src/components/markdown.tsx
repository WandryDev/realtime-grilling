// The Markdown of the agent's prompt (rules, project, sources) as text to
// read: headings, lists, paragraphs, **bold** and `code`; tables and fenced
// code keep their columns in a monospace block.

import { Fragment, type ReactNode } from "react";

const HEADING = /^(?<marks>#{1,4})\s+(?<text>.*)$/u;
const BULLET = /^(?<indent>\s*)[-*]\s+(?<text>.*)$/u;
const NUMBERED = /^(?<indent>\s*)(?<number>\d+)[.)]\s+(?<text>.*)$/u;
const TABLE = /^\s*\|/u;
const FENCE = /^\s*```/u;
const INLINE = /(?<mark>\*\*[^*]+\*\*|`[^`]+`)/gu;

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; depth: number; mark: string | null; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "mono"; text: string };

/** A block of one line, or nothing for a blank one. */
const lineBlock = (line: string): Block | null => {
  const heading = HEADING.exec(line)?.groups;
  if (heading) {
    return {
      kind: "heading",
      level: heading.marks?.length ?? 1,
      text: heading.text ?? "",
    };
  }
  const bullet = BULLET.exec(line)?.groups;
  if (bullet) {
    return {
      depth: Math.floor((bullet.indent?.length ?? 0) / 2),
      kind: "item",
      mark: null,
      text: bullet.text ?? "",
    };
  }
  const numbered = NUMBERED.exec(line)?.groups;
  if (numbered) {
    return {
      depth: Math.floor((numbered.indent?.length ?? 0) / 2),
      kind: "item",
      mark: `${numbered.number}.`,
      text: numbered.text ?? "",
    };
  }
  return line.trim() === "" ? null : { kind: "paragraph", text: line };
};

/** The lines from `start` while `inside` holds; and where they stop. */
const run = (
  lines: readonly string[],
  start: number,
  inside: (line: string) => boolean
): [string[], number] => {
  let end = start;
  while (end < lines.length && inside(lines[end] ?? "")) {
    end += 1;
  }
  return [lines.slice(start, end), end];
};

const blocks = (source: string): Block[] => {
  const result: Block[] = [];
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      const [body, end] = run(lines, index + 1, (next) => !FENCE.test(next));
      result.push({ kind: "mono", text: body.join("\n") });
      index = end + 1;
    } else if (TABLE.test(line)) {
      const [body, end] = run(lines, index, (next) => TABLE.test(next));
      result.push({ kind: "mono", text: body.join("\n") });
      index = end;
    } else {
      const block = lineBlock(line);
      if (block) {
        result.push(block);
      }
      index += 1;
    }
  }
  return result;
};

/** A line with its **bold** and `code`. */
export const inline = (text: string): ReactNode =>
  text.split(INLINE).map((part, index) => {
    const key = `${index}:${part.length}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong className="font-semibold" key={key}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          className="bg-surface rounded px-1 py-px font-mono text-[12px]"
          key={key}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });

const HEADING_CLASS: Record<number, string> = {
  1: "text-[15px] font-semibold",
  2: "text-[14px] font-semibold",
  3: "text-[13px] font-semibold",
  4: "text-[13px] font-medium",
};

const BlockView = ({ block }: { block: Block }) => {
  if (block.kind === "heading") {
    return (
      <div
        className={`${HEADING_CLASS[block.level] ?? HEADING_CLASS[4]} pt-1.5 first:pt-0`}
      >
        {inline(block.text)}
      </div>
    );
  }
  if (block.kind === "item") {
    return (
      <div className="flex gap-2" style={{ paddingLeft: block.depth * 16 }}>
        <span className="text-muted-foreground w-4 shrink-0 text-right tabular-nums">
          {block.mark ?? "•"}
        </span>
        <span className="min-w-0">{inline(block.text)}</span>
      </div>
    );
  }
  if (block.kind === "mono") {
    return (
      <pre className="bg-surface overflow-x-auto rounded-lg p-2.5 font-mono text-[11px] leading-4">
        {block.text}
      </pre>
    );
  }
  return <p>{inline(block.text)}</p>;
};

export const Markdown = ({ source }: { source: string }) => (
  <div className="text-foreground flex flex-col gap-1.5 text-[13px] leading-5 wrap-anywhere">
    {blocks(source).map((block, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a block is its place in a text that never reorders
      <BlockView block={block} key={`${block.kind}:${index}`} />
    ))}
  </div>
);
