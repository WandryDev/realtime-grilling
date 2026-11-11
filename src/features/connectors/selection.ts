import type {
  BrowseNode,
  ConnectorKind,
  SelectionItem,
  SelectionItemView,
} from "@/bindings";

/*
 * The picker's selection (outline-connector spec, «Выбор документов для
 * проекта»; clickup-connector spec, «Выбор задач для проекта»): whole
 * containers (an Outline collection; a ClickUp space, folder or list),
 * single documents (an Outline document, a ClickUp task) with their nested
 * ones, and what a picked container or document brings left out. Kept by
 * external id, in the order they were picked.
 *
 * Containers may nest (connectors-clickup design.md, decision 2): a
 * container inside a picked one is checked and can be left out like a
 * document. What a left-out document takes along follows Rust's
 * expansion of each service (`Rules`).
 */

export type Picked = ReadonlyMap<string, SelectionItem>;

/** How a service expands an exclude. */
export interface Rules {
  /**
   * A left-out document takes its nested ones along (ClickUp: a task with
   * its subtasks); otherwise it goes alone (Outline).
   */
  readonly excludeTakesNested: boolean;
}

const OUTLINE_RULES: Rules = { excludeTakesNested: false };
const CLICKUP_RULES: Rules = { excludeTakesNested: true };

export function rulesOf(kind: ConnectorKind): Rules {
  return kind === "clickup" ? CLICKUP_RULES : OUTLINE_RULES;
}

export function pickedFrom(items: readonly SelectionItemView[]): Picked {
  return new Map(
    items.map((item) => [
      item.externalId,
      {
        externalId: item.externalId,
        itemKind: item.itemKind,
        title: item.title,
        url: item.url,
      },
    ])
  );
}

export function toItems(picked: Picked): SelectionItem[] {
  return [...picked.values()];
}

function withItem(picked: Picked, item: SelectionItem): Picked {
  const next = new Map(picked);
  next.set(item.externalId, item);
  return next;
}

function without(picked: Picked, id: string): Picked {
  const next = new Map(picked);
  next.delete(id);
  return next;
}

function itemOf(node: BrowseNode, itemKind: SelectionItem["itemKind"]) {
  return { externalId: node.id, itemKind, title: node.title, url: node.url };
}

/** Where a row of the tree sits: in a picked container, under a picked document. */
export interface RowContext {
  /** A container around it is picked (and not left out). */
  readonly inPickedContainer: boolean;
  /** An ancestor document is picked: this one comes with it. */
  readonly inPickedDocument: boolean;
}

export const TOP: RowContext = {
  inPickedContainer: false,
  inPickedDocument: false,
};

/**
 * The children each container loaded, by container id (`connector_browse`
 * with it as the parent). A container that came with its `children`
 * (Outline's documents, a ClickUp folder's lists) needs no entry.
 */
export type Trees = ReadonlyMap<string, readonly BrowseNode[]>;

function covered(context: RowContext) {
  return context.inPickedContainer || context.inPickedDocument;
}

/**
 * What is inside a node as far as is known: what it loaded, what it came
 * with, nothing when it has nothing; `undefined` while not loaded.
 */
export function childrenOf(
  node: BrowseNode,
  trees: Trees
): readonly BrowseNode[] | undefined {
  const loaded = trees.get(node.id);
  if (loaded) {
    return loaded;
  }
  if (node.children.length > 0 || !node.hasChildren) {
    return node.children;
  }
  return node.kind === "document" ? node.children : undefined;
}

/**
 * Where the nested rows of a document sit. A document left out goes alone
 * in Outline (its nested ones stay picked) and takes its nested ones along
 * in ClickUp, as in Rust.
 */
export function nestedContext(
  context: RowContext,
  checked: boolean,
  rules: Rules = OUTLINE_RULES
): RowContext {
  if (covered(context)) {
    return !checked && rules.excludeTakesNested ? TOP : context;
  }
  return { inPickedContainer: false, inPickedDocument: checked };
}

/**
 * Where the rows inside a container sit: covered while it is checked (picked,
 * or in a picked one and not left out). A container left out takes
 * everything inside along; a document picked by itself there still comes.
 */
export function containerContext(checked: boolean): RowContext {
  return checked ? { inPickedContainer: true, inPickedDocument: false } : TOP;
}

/**
 * Whether a row's box is checked. A node that comes with a picked
 * container or a picked document is checked unless left out (Rust's
 * `exclude` leaves it out of both).
 */
export function rowState(
  picked: Picked,
  node: BrowseNode,
  context: RowContext
): { checked: boolean } {
  const item = picked.get(node.id);
  if (covered(context)) {
    return { checked: item?.itemKind !== "exclude" };
  }
  return { checked: item?.itemKind === itemKindOf(node) };
}

function itemKindOf(node: BrowseNode): SelectionItem["itemKind"] {
  return node.kind === "container" ? "container" : "document";
}

/** Every node of a tree with what is known inside each. */
function flatten(nodes: readonly BrowseNode[], trees: Trees): BrowseNode[] {
  const all: BrowseNode[] = [];
  const visit = (level: readonly BrowseNode[]) => {
    for (const node of level) {
      all.push(node);
      visit(childrenOf(node, trees) ?? []);
    }
  };
  visit(nodes);
  return all;
}

/** The loaded nodes, by id. */
function loadedNodes(trees: Trees) {
  const nodes = new Map<string, BrowseNode>();
  for (const tree of trees.values()) {
    for (const node of flatten(tree, trees)) {
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

/**
 * The ids the picks bring as far as the loaded trees tell, excludes not
 * applied: what an exclude may still leave out.
 */
function brought(picked: Picked, trees: Trees) {
  const nodes = loadedNodes(trees);
  const ids = new Set<string>();
  for (const [id, item] of picked) {
    if (item.itemKind === "exclude") {
      continue;
    }
    const node = nodes.get(id);
    const inside =
      item.itemKind === "container"
        ? (trees.get(id) ?? node?.children ?? [])
        : (node?.children ?? []);
    for (const nested of flatten(inside, trees)) {
      ids.add(nested.id);
    }
  }
  return { ids, nodes };
}

/**
 * Drops the excludes nothing brings any more (what brought them was
 * unchecked): Rust would ignore them, the counter too, but a later pick
 * must not inherit them. An exclude of a node not loaded is kept: it
 * can't be told.
 */
export function pruneExcludes(picked: Picked, trees: Trees): Picked {
  const { ids, nodes } = brought(picked, trees);
  let next: Map<string, SelectionItem> | undefined;
  for (const [id, item] of picked) {
    const stale = item.itemKind === "exclude" && nodes.has(id) && !ids.has(id);
    if (stale) {
      next ??= new Map(picked);
      next.delete(id);
    }
  }
  return next ?? picked;
}

/**
 * Toggles a row: a container, a document, or one that comes with a picked
 * container or document (left out, or back in). Excludes left without
 * what brought them go.
 */
export function toggle(
  picked: Picked,
  node: BrowseNode,
  context: RowContext,
  checked: boolean,
  trees: Trees
): Picked {
  let next: Picked;
  if (covered(context)) {
    next = checked
      ? without(picked, node.id)
      : withItem(picked, itemOf(node, "exclude"));
  } else {
    next = checked
      ? withItem(picked, itemOf(node, itemKindOf(node)))
      : without(picked, node.id);
  }
  return pruneExcludes(next, trees);
}

/** How many documents a selection brings, as far as the loaded tree tells. */
export interface SelectionCount {
  /**
   * Some of it is not counted yet: a picked container whose count comes
   * only when it is expanded (a ClickUp space), or a pick of a container
   * not loaded here.
   */
  readonly approximate: boolean;
  readonly count: number;
}

/**
 * Counts what the selection brings, the way Rust expands it: the picked
 * containers (by what they loaded, else by their own count), the picked
 * documents with their nested ones, less what is left out; each document
 * once. A picked document not loaded counts as itself.
 */
export function countSelection(
  picked: Picked,
  containers: readonly BrowseNode[],
  trees: Trees,
  rules: Rules = OUTLINE_RULES
): SelectionCount {
  const documents = new Set<string>();
  const seen = new Set<string>();
  let fromContainers = 0;
  let approximate = false;

  const walk = (nodes: readonly BrowseNode[], context: RowContext) => {
    for (const node of nodes) {
      seen.add(node.id);
      const { checked } = rowState(picked, node, context);
      const inside = childrenOf(node, trees);
      if (node.kind === "container") {
        if (checked && inside === undefined) {
          fromContainers += node.documentCount;
          approximate ||= node.documentCount === 0;
        } else if (inside) {
          walk(inside, containerContext(checked));
        }
        continue;
      }
      if (checked) {
        documents.add(node.id);
      }
      walk(inside ?? [], nestedContext(context, checked, rules));
    }
  };
  walk(containers, TOP);

  for (const [id, item] of picked) {
    if (seen.has(id)) {
      continue;
    }
    if (item.itemKind === "document") {
      documents.add(id);
    } else if (item.itemKind === "container") {
      approximate = true;
    }
  }
  return { approximate, count: documents.size + fromContainers };
}

/** The number of `countSelection`. */
export function countDocuments(
  picked: Picked,
  containers: readonly BrowseNode[],
  trees: Trees,
  rules: Rules = OUTLINE_RULES
): number {
  return countSelection(picked, containers, trees, rules).count;
}

/** What the search leaves of the tree. */
export interface SearchResult {
  /**
   * The rows inside each node on the way to a match, by node id: shown
   * open, with only what leads to a match. A match itself shows what is
   * inside it as usual.
   */
  readonly paths: ReadonlyMap<string, readonly BrowseNode[]>;
  readonly roots: readonly BrowseNode[];
}

/**
 * Nodes whose title has `query`, with the path to them kept. Searches what
 * is loaded: a container's loaded children count as its own.
 */
export function searchTree(
  nodes: readonly BrowseNode[],
  query: string,
  trees: Trees
): SearchResult {
  const needle = query.trim().toLowerCase();
  const paths = new Map<string, BrowseNode[]>();
  if (!needle) {
    return { paths, roots: nodes };
  }
  const filter = (level: readonly BrowseNode[]): BrowseNode[] =>
    level.flatMap((node) => {
      if (node.title.toLowerCase().includes(needle)) {
        return [node];
      }
      const children = filter(childrenOf(node, trees) ?? []);
      if (children.length === 0) {
        return [];
      }
      paths.set(node.id, children);
      return [node];
    });
  return { paths, roots: filter(nodes) };
}
