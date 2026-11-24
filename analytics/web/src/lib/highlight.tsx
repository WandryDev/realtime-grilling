"use client";

// Code colored by shiki, as Grill colors it (`src/lib/highlighter.tsx`): the
// themes and the languages load the first time they are needed, and until
// then the code shows plain.

import { type ReactNode, useEffect, useState } from "react";
import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const LANGUAGES = {
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
};

export type Language = keyof typeof LANGUAGES;

/** Longer code shows plain: coloring it would stall the page. */
const MAX_COLORED = 60_000;

let shiki: Promise<HighlighterCore> | undefined;

const load = async (language: Language): Promise<HighlighterCore> => {
  shiki ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    langs: [],
    themes: [
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ],
  });
  const highlighter = await shiki;
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(LANGUAGES[language]);
  }
  return highlighter;
};

const tokenLine = (line: ThemedToken[], row: number): ReactNode => (
  <span key={`line-${row}`}>
    {line.map((token) => (
      <span
        className="text-(--shiki-light) dark:text-(--shiki-dark)"
        key={`${row}:${token.offset}`}
        style={token.htmlStyle as React.CSSProperties}
      >
        {token.content}
      </span>
    ))}
  </span>
);

/** The lines of `code`, colored once the language has loaded. */
export const useHighlighted = (
  code: string,
  language: Language
): ReactNode[] => {
  const [colored, setColored] = useState<{
    code: string;
    lines: ReactNode[];
  } | null>(null);

  useEffect(() => {
    if (code.length > MAX_COLORED) {
      return;
    }
    let cancelled = false;
    load(language)
      .then((highlighter) => {
        const { tokens } = highlighter.codeToTokens(code, {
          defaultColor: false,
          lang: language,
          themes: { dark: "github-dark", light: "github-light" },
        });
        if (!cancelled) {
          setColored({ code, lines: tokens.map(tokenLine) });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return colored?.code === code ? colored.lines : code.split("\n");
};
