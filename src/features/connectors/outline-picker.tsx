"use client";

import { ChevronRightIcon } from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { BrowseNode, SelectionItem, SelectionItemView } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { MAX_CONNECTOR_DOCUMENTS } from "@/data/services/connectors";
import { SearchIcon } from "@/features/shell/icons";
import { cn } from "@/lib/utils";

import { browseChildren, useConnectorContainers } from "./api";
import { documentsCount } from "./labels";
import {
  countDocuments,
  filterTree,
  nestedContext,
  type Picked,
  pickedFrom,
  type RowContext,
  rowState,
  toggle,
  toItems,
} from "./selection";

/*
 * «Документы из Outline» (outline-connector spec, «Выбор документов для
 * проекта»): the team's collections, each opening its tree of documents.
 * A collection is picked whole (later documents too), a document with its
 * nested ones; unchecking a document of a picked collection leaves it out.
 * The search filters by title (it opens every collection's tree); the
 * counter says how many documents the pick brings, and over 200 the
 * dialog says so and doesn't save.
 */

type Trees = ReadonlyMap<string, readonly BrowseNode[]>;

const TOP: RowContext = { inPickedContainer: false, inPickedDocument: false };

export function OutlinePickerDialog({
  items,
  onOpenChange,
  onSave,
  open,
}: {
  /** What the project has picked now. */
  items: readonly SelectionItemView[];
  onOpenChange: (open: boolean) => void;
  /** Resolves to whether it was saved. */
  onSave: (items: SelectionItem[]) => Promise<boolean>;
  open: boolean;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-140">
        {open ? (
          <PickerBody initial={items} onClose={close} onSave={onSave} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  initial,
  onClose,
  onSave,
}: {
  initial: readonly SelectionItemView[];
  onClose: () => void;
  onSave: (items: SelectionItem[]) => Promise<boolean>;
}) {
  const { reload, state } = useConnectorContainers("outline", true);
  const containers = state.status === "ready" ? state.nodes : [];
  const [picked, setPicked] = useState<Picked>(() => pickedFrom(initial));
  const [trees, setTrees] = useState<Trees>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (container: BrowseNode) => {
    const result = await browseChildren("outline", {
      id: container.id,
      kind: "container",
    });
    if (result.status === "ready") {
      setTrees((current) => new Map(current).set(container.id, result.nodes));
    }
  }, []);

  // The search needs every tree; the picked collections need theirs for
  // the counter.
  useEffect(() => {
    for (const container of containers) {
      const wanted =
        query.trim() !== "" ||
        picked.has(container.id) ||
        expanded.has(container.id);
      if (wanted && !trees.has(container.id)) {
        load(container);
      }
    }
  }, [containers, expanded, load, picked, query, trees]);

  const count = useMemo(
    () => countDocuments(picked, containers, trees),
    [containers, picked, trees]
  );
  const overLimit = count > MAX_CONNECTOR_DOCUMENTS;
  const changed = useMemo(
    () =>
      JSON.stringify(toItems(picked)) !==
      JSON.stringify(toItems(pickedFrom(initial))),
    [initial, picked]
  );

  const handleToggle = useCallback(
    (node: BrowseNode, context: RowContext, checked: boolean) => {
      setPicked((current) => toggle(current, node, context, checked));
    },
    []
  );
  const handleExpand = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const handleQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    const saved = await onSave(toItems(picked));
    setSaving(false);
    if (saved) {
      onClose();
    }
  }, [onClose, onSave, picked]);

  const searching = query.trim() !== "";
  const visible = searching
    ? containers.flatMap((container) => {
        const tree = filterTree(trees.get(container.id) ?? [], query);
        const titleHit = filterTree([container], query).length > 0;
        return tree.length > 0 || titleHit ? [{ container, tree }] : [];
      })
    : containers.map((container) => ({
        container,
        tree: trees.get(container.id) ?? [],
      }));

  return (
    <>
      <DialogHeader>
        <DialogTitle>Документы из Outline</DialogTitle>
        <DialogDescription>
          Коллекция берётся целиком, с документами, которые появятся в ней
          позже. Документ берётся с вложенными. Grill только читает Outline.
        </DialogDescription>
      </DialogHeader>
      <div className="border-input flex flex-col overflow-clip rounded-sm border">
        <InputGroup className="border-border h-11 gap-2.5 rounded-none border-0 border-b px-3.5 not-has-[[aria-invalid=true]]:focus-within:shadow-none">
          <InputGroupAddon>
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Поиск по названию"
            onChange={handleQuery}
            placeholder="Поиск по названию"
            type="search"
            value={query}
          />
          <InputGroupAddon
            align="inline-end"
            className="text-muted-foreground tabular-nums"
          >
            выбрано {documentsCount(count)}
          </InputGroupAddon>
        </InputGroup>
        <div
          aria-busy={state.status === "loading" || undefined}
          className="flex max-h-90 min-h-30 flex-col overflow-y-auto"
        >
          {state.status === "loading" ? (
            <p className="text-muted-foreground flex h-11 items-center gap-2 px-3.5 text-sm">
              <Spinner aria-hidden="true" className="size-3.5" />
              Загружаем коллекции
            </p>
          ) : null}
          {state.status === "error" ? (
            <div className="flex items-center gap-3 px-3.5 py-3">
              <p className="text-contradiction min-w-0 flex-1 text-sm">
                {state.message}
              </p>
              <Button onClick={reload} size="sm" variant="secondary">
                Повторить
              </Button>
            </div>
          ) : null}
          {state.status === "ready" && visible.length === 0 ? (
            <p className="text-muted-foreground flex h-11 items-center px-3.5 text-sm">
              {searching ? "Ничего не нашлось" : "В Outline нет коллекций"}
            </p>
          ) : null}
          <ul aria-label="Коллекции Outline" className="flex flex-col">
            {visible.map(({ container, tree }) => (
              <CollectionRow
                container={container}
                expanded={searching || expanded.has(container.id)}
                key={container.id}
                loaded={trees.has(container.id)}
                onExpand={handleExpand}
                onToggle={handleToggle}
                picked={picked}
                tree={tree}
              />
            ))}
          </ul>
        </div>
      </div>
      {overLimit ? (
        <p className="text-contradiction text-sm" role="alert">
          Из Outline в проект загружается не больше {MAX_CONNECTOR_DOCUMENTS}{" "}
          документов, а выбрано {count}. Выберите отдельные документы или
          снимите часть.
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Отмена
        </DialogClose>
        <Button disabled={overLimit || saving || !changed} onClick={save}>
          {saving ? <Spinner aria-hidden="true" /> : null}
          Сохранить выбор
        </Button>
      </DialogFooter>
    </>
  );
}

function CollectionRow({
  container,
  expanded,
  loaded,
  onExpand,
  onToggle,
  picked,
  tree,
}: {
  container: BrowseNode;
  expanded: boolean;
  loaded: boolean;
  onExpand: (id: string) => void;
  onToggle: (node: BrowseNode, context: RowContext, checked: boolean) => void;
  picked: Picked;
  tree: readonly BrowseNode[];
}) {
  const { checked } = rowState(picked, container, TOP);
  const expand = useCallback(
    () => onExpand(container.id),
    [container.id, onExpand]
  );
  const context: RowContext = {
    inPickedContainer: checked,
    inPickedDocument: false,
  };
  return (
    <li className="border-border flex flex-col border-b last:border-b-0">
      <NodeLine
        checked={checked}
        context={TOP}
        depth={0}
        expanded={expanded}
        locked={false}
        node={container}
        onExpand={container.hasChildren ? expand : undefined}
        onToggle={onToggle}
      />
      {expanded && !loaded ? (
        <p className="text-muted-foreground flex h-9 items-center gap-2 pl-14 text-sm">
          <Spinner aria-hidden="true" className="size-3" />
          Загружаем документы
        </p>
      ) : null}
      {expanded && tree.length > 0 ? (
        <DocumentTree
          context={context}
          depth={1}
          nodes={tree}
          onToggle={onToggle}
          picked={picked}
        />
      ) : null}
    </li>
  );
}

function DocumentTree({
  context,
  depth,
  nodes,
  onToggle,
  picked,
}: {
  context: RowContext;
  depth: number;
  nodes: readonly BrowseNode[];
  onToggle: (node: BrowseNode, context: RowContext, checked: boolean) => void;
  picked: Picked;
}) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => {
        const { checked, locked } = rowState(picked, node, context);
        return (
          <li className="flex flex-col" key={node.id}>
            <NodeLine
              checked={checked}
              context={context}
              depth={depth}
              locked={locked}
              node={node}
              onToggle={onToggle}
            />
            {node.children.length > 0 ? (
              <DocumentTree
                context={nestedContext(context, checked)}
                depth={depth + 1}
                nodes={node.children}
                onToggle={onToggle}
                picked={picked}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const INDENT_PX = 20;

function NodeLine({
  checked,
  context,
  depth,
  expanded,
  locked,
  node,
  onExpand,
  onToggle,
}: {
  checked: boolean;
  context: RowContext;
  depth: number;
  expanded?: boolean;
  locked: boolean;
  node: BrowseNode;
  onExpand?: () => void;
  onToggle: (node: BrowseNode, context: RowContext, checked: boolean) => void;
}) {
  const change = useCallback(
    (value: boolean) => onToggle(node, context, value),
    [context, node, onToggle]
  );
  const container = node.kind === "container";
  return (
    <div
      className={cn(
        "hover:bg-surface flex h-11 items-center gap-3 pr-3.5 transition-colors",
        container ? "pl-2" : "pl-3.5"
      )}
      style={{
        paddingInlineStart: depth > 0 ? depth * INDENT_PX + 34 : undefined,
      }}
    >
      {container ? (
        <Button
          aria-expanded={onExpand ? expanded : undefined}
          aria-label={`${expanded ? "Свернуть" : "Открыть"} ${node.title}`}
          className={cn("text-muted-foreground", !onExpand && "invisible")}
          disabled={!onExpand}
          onClick={onExpand}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon
            className={cn(
              "size-4 transition-transform",
              expanded && "rotate-90"
            )}
          />
        </Button>
      ) : null}
      <Checkbox
        aria-label={node.title}
        checked={checked}
        disabled={locked}
        onCheckedChange={change}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          container && "font-medium"
        )}
      >
        {node.title}
      </span>
      {container || node.documentCount > 1 ? (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {documentsCount(node.documentCount)}
        </span>
      ) : null}
    </div>
  );
}
