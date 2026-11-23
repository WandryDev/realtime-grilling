"use client";

// The prompt of an agent call part by part, as an AI app shows the output of
// its tools: each part with its icon and name, a short one in a line, a long
// one opens to its own view (the topics as tags, the card as fields, the
// questions by their state, the findings as quotes with their documents, the
// transcript as a conversation). A part the call before it had is marked.

import type { AgentCallDetails } from "@grill/analytics-server/api";
import { Badge } from "@grill/ui/badge";
import { ClickUpIcon, OutlineIcon } from "@grill/ui/brand-icons";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grill/ui/trace";
import {
  AudioLinesIcon,
  BracesIcon,
  ClipboardListIcon,
  FileSearchIcon,
  FileTextIcon,
  GaugeIcon,
  HashIcon,
  LibraryIcon,
  type LucideIcon,
  MessageCircleQuestionMarkIcon,
  ScrollTextIcon,
  SearchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { inline, Markdown } from "@/components/markdown";
import { GAP_NAMES, LENS_NAMES, plural } from "@/lib/format";

type Part = (typeof AgentCallDetails.Type)["parts"][number];

const SYMBOLS = ["символ", "символа", "символов"] as const;

interface Meta {
  readonly icon: LucideIcon;
  /** Shown in its line: there is little in it. */
  readonly inline?: boolean;
  readonly name: string;
  /** The words the part starts with that its name already says. */
  readonly prefix?: string;
}

const META: Record<string, Meta> = {
  candidates: { icon: LibraryIcon, name: "Кандидаты из источников" },
  card: { icon: ClipboardListIcon, name: "Карточка темы" },
  file: { icon: ScrollTextIcon, name: "Правила" },
  findings: { icon: FileSearchIcon, name: "Находки" },
  message: { icon: FileTextIcon, name: "Материалы" },
  mode: { icon: GaugeIcon, inline: true, name: "Режим", prefix: "Режим:" },
  output: { icon: BracesIcon, inline: true, name: "Формат ответа" },
  queries: { icon: SearchIcon, name: "Прошлые запросы" },
  questions: { icon: MessageCircleQuestionMarkIcon, name: "Вопросы" },
  topics: { icon: HashIcon, name: "Темы" },
  transcript: { icon: AudioLinesIcon, name: "Расшифровка" },
};

const INLINE_LIMIT = 120;

/* What each part says, read from its text */

const TOPIC =
  /^- \[T:(?<id>[^\]]+)\]\s+(?<title>.*?)(?<current>\s+\(текущая\))?$/u;
const CARD_FIELD =
  /^- (?<lens>[A-Za-z]+): (?<value>.*?)(?: \(основания: (?<basis>[^)]*)\))?$/u;
const TRAILING_DOT = /\.$/u;
const EMPTY_LENSES = /^Пустые линзы:\s*(?<rest>.*)$/u;
// The fast loop gives a question's lens, gap and priority; the slow loop
// only its text.
const QUESTION =
  /^- \[Q:(?<id>[^\]]+)\]\s+(?:поле (?<lens>\w+), (?<gap>\w+), приоритет (?<priority>\d+):\s+)?(?<text>.*)$/u;
const TITLE = /^#{1,3}\s+(?<title>.*)$/u;
const SECTION = /^(?<title>[^\s\-#[].*):$/u;
// The fast loop's findings carry a note; the slow loop's do not.
const FINDING =
  /^- \[D(?<n>\d+)\] (?<source>\S+) «(?<name>.+?)»: «(?<quote>.*?)»(?: — (?<note>.*))?$/u;
const SEGMENT =
  /^\[S:(?<id>[^\]]+)\] (?<time>[\d:]+) (?<who>Я|Остальные): (?<text>.*)$/u;
const ITEM = /^- (?<text>.+)$/u;
const CANDIDATE =
  /^\[C(?<n>\d+)\] (?<source>\S+) «(?<name>.+?)»(?: › (?<path>.*))?$/u;

const linesOf = (text: string) => text.split("\n").map((line) => line.trim());

const Source = ({ source }: { source: string }) => {
  if (source === "Outline") {
    return <OutlineIcon className="size-3.5" />;
  }
  if (source === "ClickUp") {
    return <ClickUpIcon className="size-3.5" />;
  }
  return <FileTextIcon className="text-muted-foreground size-3.5" />;
};

const Topics = ({ text }: { text: string }) => {
  const topics = linesOf(text).flatMap((line) => {
    const match = TOPIC.exec(line)?.groups;
    return match ? [match] : [];
  });
  if (topics.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {topics.map((topic) => (
        <Badge
          indicator={false}
          key={topic.id}
          variant={topic.current ? "waiting" : "neutral"}
        >
          <HashIcon aria-hidden />
          {topic.title}
          {topic.current ? " · текущая" : ""}
        </Badge>
      ))}
    </div>
  );
};

const Card = ({ text }: { text: string }) => {
  const lines = linesOf(text);
  const fields = lines.flatMap((line) => {
    const match = CARD_FIELD.exec(line)?.groups;
    return match ? [match] : [];
  });
  const empty = lines
    .map((line) => EMPTY_LENSES.exec(line)?.groups?.rest)
    .find(Boolean);
  if (fields.length === 0) {
    return null;
  }
  return (
    <dl className="flex flex-col gap-2.5 text-[13px]">
      {fields.map((field) => (
        <div className="flex flex-col gap-0.5" key={field.lens}>
          <dt className="text-muted-foreground flex items-center gap-2 text-[12px]">
            {LENS_NAMES[field.lens ?? ""] ?? field.lens}
            {field.basis ? (
              <span className="text-subtle">
                {plural(field.basis.split(",").length, [
                  "основание",
                  "основания",
                  "оснований",
                ])}
              </span>
            ) : null}
          </dt>
          <dd className="text-foreground">{field.value}</dd>
        </div>
      ))}
      {empty ? (
        <div className="text-muted-foreground text-[12px]">
          Пусто: {empty.replace(TRAILING_DOT, "")}
        </div>
      ) : null}
    </dl>
  );
};

interface QuestionGroup {
  /** A heading of the part, not a state: shown only with questions. */
  readonly heading: boolean;
  readonly items: Record<string, string | undefined>[];
  readonly title: string;
}

const Questions = ({ text }: { text: string }) => {
  const groups: QuestionGroup[] = [];
  for (const line of linesOf(text)) {
    const title = TITLE.exec(line)?.groups?.title;
    const section = SECTION.exec(line)?.groups?.title;
    const question = QUESTION.exec(line)?.groups;
    if (title) {
      groups.push({ heading: true, items: [], title });
    } else if (section) {
      groups.push({ heading: false, items: [], title: section });
    } else if (question) {
      groups.at(-1)?.items.push(question);
    }
  }
  const shown = groups.filter(
    (group) => group.items.length > 0 || !group.heading
  );
  if (!shown.some((group) => group.items.length > 0)) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3">
      {shown.map((group) => (
        <div className="flex flex-col gap-1.5" key={group.title}>
          <div className="text-muted-foreground text-[12px]">
            {group.title} · {group.items.length}
          </div>
          {group.items.map((item) => (
            <div
              className="bg-surface flex flex-col gap-1 rounded-[10px] px-3 py-2"
              key={item.id}
            >
              <div className="text-foreground text-[13px]">{item.text}</div>
              {item.lens ? (
                <div className="text-muted-foreground flex flex-wrap gap-x-2 text-[12px]">
                  <span>{LENS_NAMES[item.lens] ?? item.lens}</span>
                  <span>{GAP_NAMES[item.gap ?? ""] ?? item.gap}</span>
                  <span>приоритет {item.priority}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

const Findings = ({ text }: { text: string }) => {
  const findings = linesOf(text).flatMap((line) => {
    const match = FINDING.exec(line)?.groups;
    return match ? [match] : [];
  });
  if (findings.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {findings.map((finding) => (
        <div
          className="bg-surface flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5 text-[13px]"
          key={finding.n}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Source source={finding.source ?? ""} />
            <span className="min-w-0 truncate">{finding.name}</span>
            <span className="text-subtle ml-auto font-normal">
              D{finding.n}
            </span>
          </div>
          <blockquote className="border-assumption text-foreground border-l-2 pl-2.5">
            {inline(finding.quote ?? "")}
          </blockquote>
          {finding.note ? (
            <div className="text-muted-foreground text-[12px]">
              {finding.note}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const Transcript = ({ text }: { text: string }) => {
  const phrases = linesOf(text).flatMap((line) => {
    const match = SEGMENT.exec(line)?.groups;
    return match ? [match] : [];
  });
  if (phrases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      {phrases.map((phrase) => {
        const client = phrase.who === "Остальные";
        return (
          <div
            className={`flex max-w-[88%] flex-col gap-0.5 rounded-[14px] px-3 py-1.5 ${
              client
                ? "bg-surface self-start"
                : "bg-foreground text-background self-end"
            }`}
            key={phrase.id}
          >
            <span
              className={`text-[11px] tabular-nums ${client ? "text-muted-foreground" : "opacity-60"}`}
            >
              {client ? "Клиент" : "Менеджер"} · {phrase.time}
            </span>
            {phrase.text}
          </div>
        );
      })}
    </div>
  );
};

const Queries = ({ text }: { text: string }) => {
  const queries = linesOf(text).flatMap((line) => {
    const query = ITEM.exec(line)?.groups?.text;
    return query ? [query] : [];
  });
  if (queries.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1 text-[13px]">
      {queries.map((query) => (
        <li className="flex items-center gap-2" key={query}>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0"
          />
          {query}
        </li>
      ))}
    </ul>
  );
};

interface Candidate {
  readonly body: string[];
  readonly n: string;
  readonly name: string;
  readonly path: string | undefined;
  readonly source: string;
}

const Candidates = ({ text }: { text: string }) => {
  const candidates: Candidate[] = [];
  for (const line of text.split("\n")) {
    const head = CANDIDATE.exec(line.trim())?.groups;
    if (head) {
      candidates.push({
        body: [],
        n: head.n ?? "",
        name: head.name ?? "",
        path: head.path,
        source: head.source ?? "",
      });
    } else {
      candidates.at(-1)?.body.push(line);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return (
    <Trace>
      {candidates.map((candidate) => (
        <TraceCollapsible key={candidate.n}>
          <TraceCollapsibleTrigger>
            <TraceLine className="text-foreground">
              <TraceIcon>
                <Source source={candidate.source} />
              </TraceIcon>
              <TraceTitle>
                {candidate.name}
                {candidate.path ? (
                  <span className="text-muted-foreground">
                    {" "}
                    › {candidate.path}
                  </span>
                ) : null}
              </TraceTitle>
              <TraceDescription>C{candidate.n}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Markdown source={candidate.body.join("\n").trim()} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ))}
    </Trace>
  );
};

const VIEWS: Record<string, (props: { text: string }) => ReactNode> = {
  candidates: Candidates,
  card: Card,
  findings: Findings,
  queries: Queries,
  questions: Questions,
  topics: Topics,
  transcript: Transcript,
};

/** A part in its own view; Markdown when the view finds nothing in it. */
const PartView = ({ label, text }: { label: string; text: string }) => {
  const View = VIEWS[label];
  const view = View ? View({ text }) : null;
  return view ?? <Markdown source={text} />;
};

const Head = ({
  meta,
  part,
  repeated,
}: {
  meta: Meta;
  part: Part;
  repeated: boolean;
}) => {
  const Icon = meta.icon;
  return (
    <TraceLine
      className="text-foreground"
      status={part.text === null ? "pending" : undefined}
      title={part.label}
    >
      <TraceIcon>
        <Icon />
      </TraceIcon>
      {/* The name never gives way: the size and the mark do. */}
      <TraceTitle className="shrink-0 font-medium">{meta.name}</TraceTitle>
      <TraceDescription className="min-w-0 shrink truncate">
        {part.text === null
          ? "текст ещё не пришёл"
          : plural(part.text.length, SYMBOLS)}
      </TraceDescription>
      {repeated ? (
        <Badge indicator={false} size="sm" variant="empty">
          <span className="sm:hidden">повтор</span>
          <span className="hidden sm:inline">как в прошлом вызове</span>
        </Badge>
      ) : null}
    </TraceLine>
  );
};

const PromptPart = ({ part, repeated }: { part: Part; repeated: boolean }) => {
  const meta = META[part.label] ?? { icon: FileTextIcon, name: part.label };
  const { text } = part;
  const short =
    text !== null &&
    (meta.inline === true ||
      (text.length <= INLINE_LIMIT && !text.trim().includes("\n")));
  if (text === null || short) {
    const shown = text
      ?.trim()
      .replace(meta.prefix ?? "", "")
      .trim();
    return (
      <div
        className="flex flex-col gap-1"
        data-repeated={repeated || undefined}
        data-testid="prompt-part"
      >
        <Head meta={meta} part={part} repeated={repeated} />
        {shown ? (
          <div className="text-foreground ml-6 text-[13px]">{shown}</div>
        ) : null}
      </div>
    );
  }
  return (
    <TraceCollapsible
      data-repeated={repeated || undefined}
      data-testid="prompt-part"
    >
      <TraceCollapsibleTrigger>
        <Head meta={meta} part={part} repeated={repeated} />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="text-foreground">
        <PartView label={part.label} text={text} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** The parts of `details`, those `previous` had marked. */
export const PromptParts = ({
  details,
  previous,
}: {
  details: typeof AgentCallDetails.Type;
  previous: typeof AgentCallDetails.Type | null;
}) => {
  const before = new Set(previous?.parts.map((part) => part.hash) ?? []);
  if (details.parts.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        Промпт не уходил в CLI.
      </p>
    );
  }
  return (
    <Trace className="gap-2.5">
      {details.parts.map((part) => (
        <PromptPart
          key={`${part.label}:${part.hash}`}
          part={part}
          repeated={before.has(part.hash)}
        />
      ))}
    </Trace>
  );
};
