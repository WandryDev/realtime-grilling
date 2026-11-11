"use client";

import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";

import type {
  ProjectConnectorView,
  ProjectSource,
  SelectionItemView,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { OutlineIcon } from "@/components/ui/brand-icons";
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
import type { IntegrationState } from "@/data/integrations";
import { documentRowId } from "@/features/projects/components/documents-block";
import { SourceTile } from "@/features/projects/components/source-mark";
import { CloseIcon } from "@/features/projects/icons";
import { relativeTime } from "@/features/projects/project-data";
import { cn } from "@/lib/utils";

import { handleServiceLink } from "./api";
import { skippedLabel, syncFailure, updatedLabel } from "./labels";

/*
 * Outline among the sources of a project (project-sources spec,
 * «Источники из коннекторов»; outline-connector spec, «Синхронизация»
 * and «Ошибки синхронизации»). The wizard's Sources step and the project
 * page draw it next to «Документы с компьютера».
 *
 * - not connected: what it is for and «Подключить Outline»;
 * - connected, nothing picked: «Выбрать в Outline»;
 * - picked: the collections and documents as chips («недоступно» when
 *   Outline lost them, with a hint when they belong to another team),
 *   when it last updated with «Обновить», why it did not
 *   («Не обновлялось: ключ не подходит»), how many documents the limit
 *   left out, then the documents: a link to Outline, when the text last
 *   changed, «нет текста», and a cross that leaves one out.
 *
 * Pure: the live wrapper (`OutlineSources`) passes the state and the
 * handlers; /dev draws each state.
 */

/** Rows shown before «Показать все». */
const FIRST_ROWS = 8;

export interface OutlineSourcesProps {
  className?: string;
  /** The connection in Settings. */
  connection: IntegrationState;
  /** The project's Outline documents (sources with `origin`). */
  documents: ProjectSource[];
  /** Fixed «now» for the previews. */
  now?: number;
  onConnect?: () => void;
  /** The cross of a document: leave it out of the project. */
  onExclude?: (source: ProjectSource) => void;
  onPick?: () => void;
  /** The cross of a picked item: take it off the selection. */
  onRemoveItem?: (item: SelectionItemView) => void;
  onSync?: () => void;
  /** «Обновить» is running. */
  syncing?: boolean;
  /** The project's selection; absent before any. */
  view?: ProjectConnectorView;
}

export function OutlineSourcesBlock({
  className,
  connection,
  documents,
  now,
  onConnect,
  onExclude,
  onPick,
  onRemoveItem,
  onSync,
  syncing = false,
  view,
}: OutlineSourcesProps) {
  const titleId = useId();
  const connected =
    connection.status === "connected" || connection.status === "error";
  const picked = view?.items ?? [];
  const chosen = picked.filter((item) => item.itemKind !== "exclude");
  const excluded = picked.filter((item) => item.itemKind === "exclude");

  let subtitle: ReactNode = "Документация из базы знаний";
  if (connected && chosen.length > 0) {
    subtitle = (
      <>
        {connection.account ?? "Outline"},{" "}
        {updatedLabel(view?.sync?.lastOkAt, now)}
      </>
    );
  } else if (connected) {
    subtitle = `${connection.account ?? "Outline"}: выберите коллекции или документы`;
  }

  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-3.5", className)}
    >
      <div className="flex items-center gap-3">
        <SourceTile kind="outline" size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-foreground text-base font-semibold" id={titleId}>
            Outline
          </h2>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </div>
        <HeaderActions
          chosen={chosen.length}
          connection={connection}
          onConnect={onConnect}
          onPick={onPick}
          onSync={onSync}
          syncing={syncing}
        />
      </div>
      {chosen.length > 0 || excluded.length > 0 ? (
        <SyncNotes connection={connection} now={now} view={view} />
      ) : null}
      {chosen.length > 0 ? (
        <ul aria-label="Выбрано в Outline" className="flex flex-wrap gap-1.5">
          {chosen.map((item) => (
            <li key={item.externalId}>
              <PickedChip item={item} onRemove={onRemoveItem} />
            </li>
          ))}
          {excluded.map((item) => (
            <li key={item.externalId}>
              <PickedChip item={item} onRemove={onRemoveItem} />
            </li>
          ))}
        </ul>
      ) : null}
      {documents.length > 0 ? (
        <OutlineDocuments
          documents={documents}
          now={now}
          onExclude={onExclude}
        />
      ) : null}
    </section>
  );
}

function HeaderActions({
  chosen,
  connection,
  onConnect,
  onPick,
  onSync,
  syncing,
}: {
  chosen: number;
  connection: IntegrationState;
  onConnect?: () => void;
  onPick?: () => void;
  onSync?: () => void;
  syncing: boolean;
}) {
  if (connection.status === "connecting") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Spinner aria-hidden="true" className="size-3.5" />
        Подключаем…
      </p>
    );
  }
  if (connection.status === "disconnected") {
    return (
      <Button onClick={onConnect} size="sm" variant="secondary">
        Подключить Outline
      </Button>
    );
  }
  if (connection.status === "error") {
    return (
      <Button onClick={onConnect} size="sm" variant="secondary">
        Обновить ключ
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {chosen > 0 ? (
        <Button
          aria-label="Обновить документы Outline"
          disabled={syncing}
          onClick={onSync}
          size="sm"
          variant="ghost"
        >
          {syncing ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : (
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          )}
          {syncing ? "Обновляем…" : "Обновить"}
        </Button>
      ) : null}
      <Button onClick={onPick} size="sm" variant="secondary">
        {chosen > 0 ? "Изменить выбор" : "Выбрать в Outline"}
      </Button>
    </div>
  );
}

/** Why the documents are not fresh, and what the limit left out. */
function SyncNotes({
  connection,
  now,
  view,
}: {
  connection: IntegrationState;
  now?: number;
  view?: ProjectConnectorView;
}) {
  const sync = view?.sync ?? null;
  let failure = syncFailure(sync);
  if (!failure && connection.status === "disconnected") {
    failure = "Outline отключён";
  } else if (!failure && connection.status === "error") {
    failure = "ключ не подходит";
  }
  const skipped = sync?.skipped ?? 0;
  if (!(failure || skipped > 0)) {
    return null;
  }
  const last = sync?.lastOkAt
    ? `, документы с текстом от ${relativeTime(sync.lastOkAt, now)}`
    : "";
  return (
    <div className="flex flex-col gap-1 pl-11">
      {failure ? (
        <p className="text-contradiction text-sm" role="status">
          Не обновлялось: {failure}
          {last}
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-assumption text-sm">
          {skippedLabel(skipped)}: в выборе больше 200 документов, в проекте 200
          последних изменённых
        </p>
      ) : null}
    </div>
  );
}

const ITEM_KIND_LABEL: Record<SelectionItemView["itemKind"], string> = {
  container: "коллекция",
  document: "документ",
  exclude: "без документа",
};

function PickedChip({
  item,
  onRemove,
}: {
  item: SelectionItemView;
  onRemove?: (item: SelectionItemView) => void;
}) {
  const remove = useCallback(() => onRemove?.(item), [item, onRemove]);
  const unavailable = item.status === "unavailable";
  const excluded = item.itemKind === "exclude";
  let hint: string | undefined;
  if (item.otherAccount) {
    hint = "выбрано в другой команде Outline";
  } else if (unavailable) {
    hint = "удалено в Outline или нет доступа";
  }
  return (
    <span
      className={cn(
        "bg-surface flex h-7 items-center gap-1.5 rounded-full pr-1 pl-2.5 text-sm",
        excluded && "text-muted-foreground"
      )}
      title={hint}
    >
      <span className="text-muted-foreground text-xs">
        {ITEM_KIND_LABEL[item.itemKind]}
      </span>
      <span className={cn("max-w-60 truncate", excluded && "line-through")}>
        {item.title}
      </span>
      {unavailable ? (
        <Badge className="text-xs" size="sm" variant="contradiction">
          недоступно
        </Badge>
      ) : null}
      {hint ? <span className="sr-only">: {hint}</span> : null}
      {item.otherAccount ? (
        <span aria-hidden="true" className="text-muted-foreground text-xs">
          другая команда
        </span>
      ) : null}
      {onRemove ? (
        <Button
          aria-label={
            excluded ? `Вернуть ${item.title}` : `Снять выбор ${item.title}`
          }
          className="text-subtle size-5"
          onClick={remove}
          size="icon-sm"
          variant="ghost"
        >
          <CloseIcon className="size-3.5" />
        </Button>
      ) : null}
    </span>
  );
}

function OutlineDocuments({
  documents,
  now,
  onExclude,
}: {
  documents: ProjectSource[];
  now?: number;
  onExclude?: (source: ProjectSource) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? documents : documents.slice(0, FIRST_ROWS);
  const showAll = useCallback(() => setAll(true), []);
  return (
    <div className="flex flex-col">
      <ul aria-label="Документы Outline" className="flex flex-col">
        {shown.map((source) => (
          <li id={documentRowId(source.id)} key={source.id}>
            <OutlineDocumentRow
              now={now}
              onExclude={onExclude}
              source={source}
            />
          </li>
        ))}
      </ul>
      {shown.length < documents.length ? (
        <Button
          className="self-start"
          onClick={showAll}
          size="sm"
          variant="ghost"
        >
          Показать все {documents.length}
        </Button>
      ) : null}
    </div>
  );
}

function OutlineDocumentRow({
  now,
  onExclude,
  source,
}: {
  now?: number;
  onExclude?: (source: ProjectSource) => void;
  source: ProjectSource;
}) {
  const exclude = useCallback(
    (_event: MouseEvent<HTMLButtonElement>) => onExclude?.(source),
    [onExclude, source]
  );
  const url = source.origin?.url;
  const updated = source.origin
    ? `текст от ${relativeTime(source.origin.updatedAt, now)}`
    : "";
  const noText = source.status !== "ready";
  return (
    <Item className="px-0 py-2.5 last:border-b-0" variant="divided">
      <ItemMedia>
        <OutlineIcon aria-hidden="true" className="size-4" />
      </ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle className="truncate">
          {url ? (
            <a
              className="hover:text-muted-foreground focus-visible:focus-ring inline-flex items-center gap-1 rounded-xs transition-colors"
              href={url}
              onClick={handleServiceLink}
              rel="noopener noreferrer"
              target="_blank"
            >
              {source.name}
              <ExternalLinkIcon
                aria-hidden="true"
                className="text-subtle size-3"
              />
            </a>
          ) : (
            source.name
          )}
        </ItemTitle>
        <ItemDescription>
          {noText ? `${source.error ?? "Нет текста"}, ` : ""}
          {updated}
          {source.truncated ? ", дальше обрезано" : ""}
        </ItemDescription>
      </ItemContent>
      {noText ? (
        <Badge className="text-xs" size="sm" variant="empty">
          нет текста
        </Badge>
      ) : null}
      {onExclude ? (
        <ItemActions>
          <Button
            aria-label={`Убрать ${source.name} из проекта`}
            className="text-subtle -mx-1.5"
            onClick={exclude}
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
