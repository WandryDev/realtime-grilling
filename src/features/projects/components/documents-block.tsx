"use client";

import { FileTextIcon, UploadIcon } from "lucide-react";
import { type MouseEvent, useCallback, useId } from "react";

import type { ProjectSource } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { CloseIcon } from "../icons";
import type { SourceKind } from "../mock";
import { SOURCE_NAME, SourceTile } from "./source-mark";

/*
 * "Документы с компьютера" (project-sources spec): ТЗ, переписка, договор
 * for the brief. "Выбрать файлы" opens the system dialog, files can also be
 * dropped on the window (in the app; the browser demo only says so). Each
 * document says what reading it gave: read with its size in characters, no
 * text (a scan), or an error. Files that were not taken stay listed under
 * it with the reason until the next add.
 *
 * The wizard's sources step and the project page draw the same block.
 */

/** A file `project_sources_add` turned away, with the reason to show. */
export interface RejectedDocument {
  message: string;
  name: string;
}

export const DOCUMENT_TYPES_HINT = ".md, .txt, .pdf и .docx до 20 МБ";

const NUMBER = new Intl.NumberFormat("ru-RU");
const BYTES_PER_KB = 1024;

/** 1 символ, 2 символа, 5 символов. */
function charsLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  let word = "символов";
  if (mod10 === 1 && mod100 !== 11) {
    word = "символ";
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    word = "символа";
  }
  return `${NUMBER.format(count)} ${word}`;
}

function sizeLabel(bytes: number) {
  const kb = bytes / BYTES_PER_KB;
  if (kb < BYTES_PER_KB) {
    return `${NUMBER.format(Math.max(1, Math.round(kb)))} КБ`;
  }
  return `${NUMBER.format(Math.round((kb / BYTES_PER_KB) * 10) / 10)} МБ`;
}

/** What reading the document gave, in words. */
export function documentStatus(source: ProjectSource): {
  detail: string;
  label: string;
  variant: "confirmed" | "empty" | "contradiction";
} {
  if (source.status === "ready") {
    const truncated = source.truncated ? ", дальше обрезано" : "";
    return {
      detail: `прочитан ${charsLabel(source.textChars)}${truncated}`,
      label: "прочитан",
      variant: "confirmed",
    };
  }
  if (source.status === "noText") {
    return {
      detail: source.error ?? "Нет текста",
      label: "нет текста",
      variant: "empty",
    };
  }
  return {
    detail: source.error ?? "Не удалось прочитать файл",
    label: "ошибка",
    variant: "contradiction",
  };
}

/** Element id of a document's row: key documents of the brief link to it. */
export function documentRowId(sourceId: string) {
  return `source-${sourceId}`;
}

export function DocumentsBlock({
  adding = false,
  className,
  documents: sources,
  dropActive = false,
  dropSupported,
  onPick,
  onRemove,
  rejected = [],
}: {
  /** Files are being copied and read: the button waits. */
  adding?: boolean;
  className?: string;
  documents: ProjectSource[];
  /** Files are dragged over the window. */
  dropActive?: boolean;
  /** Dropped files reach the app (Tauri); the browser only says so. */
  dropSupported: boolean;
  onPick?: () => void;
  /** The cross of a document; its id is in `data-id`. */
  onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
  rejected?: RejectedDocument[];
}) {
  const titleId = useId();
  // A connector's documents are listed with their service.
  const documents = sources.filter((source) => !source.origin);
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-3.5", className)}
    >
      <div className="flex items-center gap-3">
        <span className="bg-surface flex size-8 shrink-0 items-center justify-center rounded-xs">
          <FileTextIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
            strokeWidth={1.75}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-foreground text-base font-semibold" id={titleId}>
            Документы с компьютера
          </h2>
          <p className="text-muted-foreground text-sm">
            ТЗ, переписка, договор: {DOCUMENT_TYPES_HINT}
          </p>
        </div>
      </div>
      <div
        className={cn(
          "border-border-strong flex items-center gap-3 rounded-md border border-dashed px-4 py-3.5 transition-colors",
          dropActive && "border-foreground bg-surface"
        )}
        data-drop-active={dropActive || undefined}
      >
        <UploadIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.75}
        />
        <p className="text-muted-foreground min-w-0 flex-1 text-sm">
          {dropSupported
            ? "Перетащите файлы в окно или выберите их"
            : "Перетаскивание работает в приложении Grill, здесь выберите файлы кнопкой"}
        </p>
        <Button
          disabled={adding || !onPick}
          onClick={onPick}
          size="sm"
          variant="secondary"
        >
          {adding ? <Spinner /> : null}
          Выбрать файлы
        </Button>
      </div>
      {documents.length > 0 ? (
        <ul aria-label="Документы проекта" className="flex flex-col">
          {documents.map((source) => (
            <li id={documentRowId(source.id)} key={source.id}>
              <DocumentRow onRemove={onRemove} source={source} />
            </li>
          ))}
        </ul>
      ) : null}
      {rejected.length > 0 ? (
        <ul aria-label="Не добавлены" className="flex flex-col gap-1.5">
          {rejected.map((file) => (
            <li className="text-sm" key={file.name}>
              <span className="text-foreground">{file.name}</span>
              <span className="text-contradiction">: {file.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DocumentRow({
  onRemove,
  source,
}: {
  onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
  source: ProjectSource;
}) {
  const status = documentStatus(source);
  const remove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => onRemove?.(event),
    [onRemove]
  );
  return (
    <Item className="px-0 py-2.5 last:border-b-0" variant="divided">
      <ItemMedia>
        <FileTextIcon
          aria-hidden="true"
          className="text-muted-foreground size-4"
          strokeWidth={1.75}
        />
      </ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle className="truncate">{source.name}</ItemTitle>
        <ItemDescription
          className={cn(source.status === "failed" && "text-contradiction")}
        >
          {sizeLabel(source.size)}, {status.detail}
        </ItemDescription>
      </ItemContent>
      <Badge className="text-xs" size="sm" variant={status.variant}>
        {status.label}
      </Badge>
      {onRemove ? (
        <ItemActions>
          <Button
            aria-label={`Удалить ${source.name}`}
            className="text-subtle -mx-1.5"
            data-id={source.id}
            onClick={remove}
            size="icon-sm"
            variant="ghost"
          >
            <CloseIcon className="size-4" />
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}

const SOON: { description: string; kind: SourceKind }[] = [
  { description: "Код", kind: "github" },
  { description: "Задачи и комментарии", kind: "clickup" },
];

/**
 * GitHub and ClickUp until their connectors come: drawn with «скоро»,
 * nothing to pick (project-sources spec, «Коннекторы в мастере и на
 * странице проекта»). Outline has its own block.
 */
export function SoonIntegrations({ className }: { className?: string }) {
  return (
    <ul aria-label="Интеграции" className={cn("flex flex-col", className)}>
      {SOON.map((integration) => (
        <li aria-disabled="true" key={integration.kind}>
          <Item className="px-0 py-2.5 last:border-b-0" variant="divided">
            <ItemMedia>
              <SourceTile
                className="opacity-60"
                kind={integration.kind}
                size="lg"
              />
            </ItemMedia>
            <ItemContent className="gap-0.5">
              <ItemTitle className="text-muted-foreground">
                {SOURCE_NAME[integration.kind]}
              </ItemTitle>
              <ItemDescription>
                {integration.description}, подключится позже
              </ItemDescription>
            </ItemContent>
            <Badge className="text-xs" size="sm" variant="neutral">
              скоро
            </Badge>
          </Item>
        </li>
      ))}
    </ul>
  );
}
