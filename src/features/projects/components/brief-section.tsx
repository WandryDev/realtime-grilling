import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { RowStatus } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";

import { ExternalIcon } from "../icons";
import { type DocumentKind, SourceMark } from "./source-mark";

/*
 * The brief on the project page: the product in a paragraph, modules, the
 * stack, the client's glossary, and the key documents on the right (300).
 * The demo projects draw the Paper brief; a stored brief maps onto the same
 * shape (`project-data.ts`).
 */

export interface BriefModuleView {
  /** "противоречие, уточнить": the agent saw two versions. */
  conflict?: string;
  /** What the module does, under its name (a stored brief). */
  description?: string;
  name: string;
  /** "этап 1", on the right. */
  stage?: string;
}

export interface KeyDocument {
  /** Where the row leads: the document in "Источники". */
  href?: string;
  kind: DocumentKind;
  meta: string;
  metaMono?: boolean;
  mono?: boolean;
  title: string;
}

export interface BriefView {
  glossary: { definition: string; term: string }[];
  keyDocuments: KeyDocument[];
  keyDocumentsNote: string;
  modules: BriefModuleView[];
  product: string;
  stack: string[];
}

/** Muted label over a block of the brief. */
export function BriefLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h3 className={cn("text-muted-foreground text-sm font-normal", className)}>
      {children}
    </h3>
  );
}

export function BriefBody({
  brief,
  className,
}: {
  brief: BriefView;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-12", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-7">
        <section className="flex flex-col gap-2">
          <BriefLabel>Продукт</BriefLabel>
          <p className="text-foreground max-w-[640px] text-lg">
            {brief.product}
          </p>
        </section>
        {brief.modules.length > 0 ? (
          <BriefModules modules={brief.modules} />
        ) : null}
        {brief.stack.length > 0 ? <BriefStack stack={brief.stack} /> : null}
        {brief.glossary.length > 0 ? (
          <BriefGlossary glossary={brief.glossary} />
        ) : null}
      </div>
      <KeyDocuments
        className="w-75 shrink-0"
        documents={brief.keyDocuments}
        note={brief.keyDocumentsNote}
      />
    </div>
  );
}

export function BriefModules({
  className,
  modules,
}: {
  className?: string;
  modules: BriefModuleView[];
}) {
  return (
    <section className={cn("flex flex-col gap-1", className)}>
      <BriefLabel className="pb-1.5">Модули</BriefLabel>
      <ul className="flex flex-col gap-1">
        {modules.map((module) =>
          module.description ? (
            <li
              className="border-border flex shrink-0 flex-col gap-0.5 border-b py-2 last:border-b-0"
              key={module.name}
            >
              <span className="text-foreground text-base">{module.name}</span>
              <span className="text-muted-foreground text-sm">
                {module.description}
              </span>
            </li>
          ) : (
            <li
              className="border-border flex h-9 shrink-0 items-center gap-3 border-b last:border-b-0"
              key={module.name}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-base",
                  module.conflict ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {module.name}
              </span>
              {module.conflict ? (
                <button
                  className="focus-visible:focus-ring -mx-1 flex rounded-full px-1"
                  type="button"
                >
                  <RowStatus dot tone="contradiction">
                    {module.conflict}
                  </RowStatus>
                </button>
              ) : (
                <span className="text-muted-foreground text-sm">
                  {module.stage}
                </span>
              )}
            </li>
          )
        )}
      </ul>
    </section>
  );
}

export function BriefStack({
  className,
  stack,
}: {
  className?: string;
  stack: string[];
}) {
  return (
    <section className={cn("flex flex-col gap-2.5", className)}>
      <BriefLabel>Стек</BriefLabel>
      <ul className="flex flex-wrap gap-1.5">
        {stack.map((item) => (
          <li key={item}>
            <Badge className="text-foreground h-7 font-mono text-xs">
              {item}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BriefGlossary({
  className,
  glossary,
}: {
  className?: string;
  glossary: BriefView["glossary"];
}) {
  return (
    <section className={cn("flex flex-col gap-2.5", className)}>
      <BriefLabel>Глоссарий клиента</BriefLabel>
      <dl className="flex flex-col gap-2.5">
        {glossary.map((entry) => (
          <div className="flex gap-4" key={entry.term}>
            <dt className="text-foreground w-40 shrink-0 text-base font-medium">
              {entry.term}
            </dt>
            <dd className="text-muted-foreground max-w-[480px] min-w-0 flex-1 text-base">
              {entry.definition}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Documents the agent picked for the brief, on a gray panel. A hovered row
 * turns white and shows the arrow; `hovered` pins that look for the preview.
 */
export function KeyDocuments({
  className,
  documents,
  hovered = 0,
  note,
}: {
  className?: string;
  documents: KeyDocument[];
  /** Index of the row shown hovered. */
  hovered?: number;
  note: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <BriefLabel>Ключевые документы</BriefLabel>
      {documents.length > 0 ? (
        <ul className="bg-surface flex flex-col rounded-md p-1.5">
          {documents.map((document, index) => (
            <li key={`${document.title}-${document.meta}`}>
              <a
                className="group/doc hover:bg-background hover:shadow-touch focus-visible:focus-ring flex items-center gap-2.5 rounded-sm p-2.5 transition-[background-color,box-shadow]"
                data-preview={index === hovered ? "hover" : undefined}
                href={document.href ?? "#key-document"}
              >
                <SourceMark className="size-4" kind={document.kind} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "text-foreground truncate",
                      document.mono ? "font-mono text-sm/5" : "text-base"
                    )}
                  >
                    {document.title}
                  </span>
                  <span
                    className={cn(
                      "text-muted-foreground truncate text-xs",
                      (document.mono || document.metaMono) && "font-mono"
                    )}
                  >
                    {document.meta}
                  </span>
                </span>
                <ExternalIcon className="text-subtle hidden size-3 group-hover/doc:block" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground px-1 text-xs">{note}</p>
    </section>
  );
}
