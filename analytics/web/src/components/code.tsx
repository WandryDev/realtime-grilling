"use client";

// A colored block of code with its name and a copy button, scrolled inside
// when it is tall.

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@grill/ui/code-block";
import type { ReactNode } from "react";
import { type Language, useHighlighted } from "@/lib/highlight";

export const Code = ({
  code,
  language,
  maxHeight = "max-h-[420px]",
  title,
}: {
  code: string;
  language: Language;
  maxHeight?: string;
  title?: ReactNode;
}) => {
  const lines = useHighlighted(code, language);
  return (
    <CodeBlock className="bg-background" size="sm">
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle>{title}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        </CodeBlockHeader>
      ) : null}
      <CodeBlockContent className={maxHeight} wrap>
        {lines.map((line, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the code
          <CodeBlockLine key={row}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};
