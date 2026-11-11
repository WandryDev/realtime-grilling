"use client";

import { ChevronRightIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
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
import type { SaveSelectionResult } from "@/data/connector-selections";
import { MAX_CONNECTOR_DOCUMENTS } from "@/data/services/connectors";
import { SearchIcon } from "@/features/shell/icons";
import { cn } from "@/lib/utils";

import { type LazyTree, useConnectorContainers, useLazyTree } from "./api";
import {
  CONNECTOR_WORDS,
  type ConnectorWords,
  documentsCount,
  type SourceConnector,
} from "./labels";
import {
  childrenOf,
  containerContext,
  countSelection,
  nestedContext,
  type Picked,
  pickedFrom,
  type RowContext,
  type Rules,
  rowState,
  rulesOf,
  type SearchResult,
  searchTree,
  TOP,
  toggle,
  toItems,
} from "./selection";

/*
 * The picker of a connector's documents (outline-connector spec, «Выбор
 * документов для проекта»; clickup-connector spec, «Выбор задач для
 * проекта»; connectors-clickup design.md, decision 2). The top level is
 * the service's containers (Outline's collections, ClickUp's spaces); any
 * container opens with its arrow and loads what is inside on demand, once
 * (ClickUp: a space's folders and lists, a list's tasks; Outline: a
 * collection's whole tree). A container that came with its children
 * (a ClickUp folder's lists) opens without a request. A load that failed
 * says so in the container with «Повторить».
 *
 * A container is picked whole (later documents too), a document with its
 * nested ones; unchecking something that comes with a picked container or
 * document leaves it out. The search filters what is loaded by title and
 * opens the way to what it found. The counter says how many documents the
 * pick brings ("примерно" while a picked container is not counted yet),
 * and over 200 the dialog says so and doesn't save; a refusal of the
 * backend (its exact count) shows the same way and keeps the dialog open.
 */

export function ConnectorPickerDialog({
  items,
  kind,
  onOpenChange,
  onSave,
  open,
}: {
  /** What the project has picked now. */
  items: readonly SelectionItemView[];
  kind: SourceConnector;
  onOpenChange: (open: boolean) => void;
  onSave: (items: SelectionItem[]) => Promise<SaveSelectionResult>;
  open: boolean;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-140">
        {open ? (
          <PickerBody
            initial={items}
            kind={kind}
            onClose={close}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const NO_NODES: readonly BrowseNode[] = [];

/** What every row of the tree needs. */
interface TreeProps {
  readonly expanded: ReadonlySet<string>;
  readonly kind: SourceConnector;
  readonly onExpand: (node: BrowseNode) => void;
  readonly onRetry: (node: BrowseNode) => void;
  readonly onToggle: (
    node: BrowseNode,
    context: RowContext,
    checked: boolean
  ) => void;
  readonly picked: Picked;
  readonly rules: Rules;
  /** `null` while not searching. */
  readonly search: SearchResult | null;
  readonly tree: LazyTree;
}

function PickerBody({
  initial,
  kind,
  onClose,
  onSave,
}: {
  initial: readonly SelectionItemView[];
  kind: SourceConnector;
  onClose: () => void;
  onSave: (items: SelectionItem[]) => Promise<SaveSelectionResult>;
}) {
  const words = CONNECTOR_WORDS[kind];
  const rules = rulesOf(kind);
  const { reload, state } = useConnectorContainers(kind, true);
  const roots = state.status === "ready" ? state.nodes : NO_NODES;
  const tree = useLazyTree(kind);
  const { load, trees } = tree;
  const [picked, setPicked] = useState<Picked>(() => pickedFrom(initial));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string>();
  const searching = query.trim() !== "";

  // The counter needs what the picked top containers hold (a ClickUp
  // space is counted only once expanded), the search every top
  // container's. `load` asks each container once.
  useEffect(() => {
    for (const root of roots) {
      const wanted = searching || picked.get(root.id)?.itemKind === "container";
      if (wanted && root.kind === "container") {
        load(root);
      }
    }
  }, [load, picked, roots, searching]);

  const search = useMemo(
    () => (searching ? searchTree(roots, query, trees) : null),
    [query, roots, searching, trees]
  );
  const { approximate, count } = useMemo(
    () => countSelection(picked, roots, trees, rules),
    [picked, roots, rules, trees]
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
      setRefused(undefined);
      setPicked((current) => toggle(current, node, context, checked, trees));
    },
    [trees]
  );
  const handleExpand = useCallback(
    (node: BrowseNode) => {
      const opening = !expanded.has(node.id);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        return next;
      });
      if (opening && childrenOf(node, trees) === undefined) {
        load(node);
      }
    },
    [expanded, load, trees]
  );
  const handleQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setRefused(undefined);
    const result = await onSave(toItems(picked));
    setSaving(false);
    if (result.saved) {
      onClose();
    } else if (result.refused) {
      setRefused(result.refused);
    }
  }, [onClose, onSave, picked]);

  const treeProps: TreeProps = {
    expanded,
    kind,
    onExpand: handleExpand,
    onRetry: load,
    onToggle: handleToggle,
    picked,
    rules,
    search,
    tree,
  };
  const visible = search ? search.roots : roots;
  let counter = `выбрано ${approximate ? "примерно " : ""}${documentsCount(count, kind)}`;
  if (approximate && count === 0) {
    counter = "выбрано, считаем…";
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{words.pickerTitle}</DialogTitle>
        <DialogDescription>{words.pickerDescription}</DialogDescription>
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
            {counter}
          </InputGroupAddon>
        </InputGroup>
        <div
          aria-busy={state.status === "loading" || undefined}
          className="flex max-h-90 min-h-30 flex-col overflow-y-auto"
        >
          {state.status === "loading" ? (
            <p className="text-muted-foreground flex h-11 items-center gap-2 px-3.5 text-sm">
              <Spinner aria-hidden="true" className="size-3.5" />
              {words.rootsLoading}
            </p>
          ) : null}
          {state.status === "error" ? (
            <LoadError message={state.message} onRetry={reload} />
          ) : null}
          {state.status === "ready" && visible.length === 0 ? (
            <p className="text-muted-foreground flex h-11 items-center px-3.5 text-sm">
              {searching ? "Ничего не нашлось" : words.rootsEmpty}
            </p>
          ) : null}
          <ul aria-label={words.roots} className="flex flex-col">
            {visible.map((node) => (
              <li
                className="border-border flex flex-col border-b last:border-b-0"
                key={node.id}
              >
                <NodeRow context={TOP} depth={0} node={node} {...treeProps} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      <LimitNote
        count={count}
        overLimit={overLimit}
        refused={refused}
        words={words}
      />
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

/** Over the limit by the counter, or refused by the backend's count. */
function LimitNote({
  count,
  overLimit,
  refused,
  words,
}: {
  count: number;
  overLimit: boolean;
  refused?: string;
  words: ConnectorWords;
}) {
  let text: ReactNode = null;
  if (refused) {
    text = refused;
  } else if (overLimit) {
    text = `Из ${words.service} в проект загружается не больше ${MAX_CONNECTOR_DOCUMENTS} ${words.unitMany}, а выбрано ${count}. ${words.overLimitHint}`;
  }
  return text ? (
    <p className="text-contradiction text-sm" role="alert">
      {text}
    </p>
  ) : null;
}

function LoadError({
  className,
  message,
  onRetry,
}: {
  className?: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-3 px-3.5 py-3", className)}>
      <p className="text-contradiction min-w-0 flex-1 text-sm">{message}</p>
      <Button onClick={onRetry} size="sm" variant="secondary">
        Повторить
      </Button>
    </div>
  );
}

const INDENT_PX = 20;
/** Where a row's content starts: a container's arrow, a document's box. */
const CONTAINER_START_PX = 8;
const DOCUMENT_START_PX = 34;

/** A node with what is inside it, open or not. */
function NodeRow({
  context,
  depth,
  node,
  ...props
}: TreeProps & { context: RowContext; depth: number; node: BrowseNode }) {
  const { expanded, onRetry, picked, rules, search, tree } = props;
  const { checked } = rowState(picked, node, context);
  const container = node.kind === "container";
  const path = search?.paths.get(node.id);
  const inside = path ?? childrenOf(node, tree.trees);
  const expandable =
    container && (node.hasChildren || node.children.length > 0);
  const open = !container || path !== undefined || expanded.has(node.id);
  const error = expandable && open ? tree.errors.get(node.id) : undefined;
  const loading = expandable && open && !error && inside === undefined;
  const retry = useCallback(() => onRetry(node), [node, onRetry]);
  const nested = container
    ? containerContext(checked)
    : nestedContext(context, checked, rules);

  return (
    <>
      <NodeLine
        checked={checked}
        context={context}
        depth={depth}
        expandable={expandable}
        kind={props.kind}
        node={node}
        onExpand={props.onExpand}
        onToggle={props.onToggle}
        open={open}
      />
      {error ? (
        <LoadError className="py-1.5" message={error} onRetry={retry} />
      ) : null}
      {loading ? (
        <p
          className="text-muted-foreground flex h-9 items-center gap-2 text-sm"
          style={{
            paddingInlineStart: (depth + 1) * INDENT_PX + DOCUMENT_START_PX,
          }}
        >
          <Spinner aria-hidden="true" className="size-3" />
          Загружаем
        </p>
      ) : null}
      {open && inside && inside.length > 0 ? (
        <ul className="flex flex-col">
          {inside.map((child) => (
            <li className="flex flex-col" key={child.id}>
              <NodeRow
                context={nested}
                depth={depth + 1}
                node={child}
                {...props}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The arrow of a container, the box, the title and what it brings. */
function NodeLine({
  checked,
  context,
  depth,
  expandable,
  kind,
  node,
  onExpand,
  onToggle,
  open,
}: {
  checked: boolean;
  context: RowContext;
  depth: number;
  expandable: boolean;
  kind: SourceConnector;
  node: BrowseNode;
  onExpand: (node: BrowseNode) => void;
  onToggle: TreeProps["onToggle"];
  open: boolean;
}) {
  const container = node.kind === "container";
  const expand = useCallback(() => onExpand(node), [node, onExpand]);
  const change = useCallback(
    (value: boolean) => onToggle(node, context, value),
    [context, node, onToggle]
  );
  const counted = container ? node.documentCount > 0 : node.documentCount > 1;
  return (
    <div
      className="hover:bg-surface flex h-11 items-center gap-3 pr-3.5 transition-colors"
      style={{
        paddingInlineStart:
          depth * INDENT_PX +
          (container ? CONTAINER_START_PX : DOCUMENT_START_PX),
      }}
    >
      {container ? (
        <Button
          aria-expanded={expandable ? open : undefined}
          aria-label={`${open ? "Свернуть" : "Открыть"} ${node.title}`}
          className={cn("text-muted-foreground", !expandable && "invisible")}
          disabled={!expandable}
          onClick={expand}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
        </Button>
      ) : null}
      <Checkbox
        aria-label={node.title}
        checked={checked}
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
      {counted ? (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {documentsCount(node.documentCount, kind)}
        </span>
      ) : null}
    </div>
  );
}
