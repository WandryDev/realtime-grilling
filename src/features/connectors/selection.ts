import type { BrowseNode, SelectionItem, SelectionItemView } from "@/bindings";

/*
 * The picker's selection (outline-connector spec, «Выбор документов для
 * проекта»): whole collections, single documents with their nested ones,
 * and documents of a picked collection left out. Kept by external id, in
 * the order they were picked.
 */

export type Picked = ReadonlyMap<string, SelectionItem>;

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

/** Where a row of the tree sits: in a picked collection, under a picked document. */
export interface RowContext {
  /** Its collection is picked whole. */
  readonly inPickedContainer: boolean;
  /** An ancestor document is picked: this one comes with it. */
  readonly inPickedDocument: boolean;
}

/** The loaded trees of the collections, by collection id. */
export type Trees = ReadonlyMap<string, readonly BrowseNode[]>;

function covered(context: RowContext) {
  return context.inPickedContainer || context.inPickedDocument;
}

/**
 * Where the nested rows of a document sit. A document left out goes alone
 * (as in Rust): its nested ones stay picked.
 */
export function nestedContext(
  context: RowContext,
  checked: boolean
): RowContext {
  if (covered(context)) {
    return context;
  }
  return { inPickedContainer: false, inPickedDocument: checked };
}

/**
 * Whether a row's box is checked. A document that comes with a picked
 * collection or a picked document is checked unless left out (Rust's
 * `exclude` leaves it out of both).
 */
export function rowState(
  picked: Picked,
  node: BrowseNode,
  context: RowContext
): { checked: boolean } {
  const item = picked.get(node.id);
  if (node.kind === "container") {
    return { checked: item?.itemKind === "container" };
  }
  if (covered(context)) {
    return { checked: item?.itemKind !== "exclude" };
  }
  return { checked: item?.itemKind === "document" };
}

/** Every node of a tree, its nested ones included. */
function flatten(nodes: readonly BrowseNode[]): BrowseNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** The loaded nodes of every collection, by id. */
function loadedNodes(trees: Trees) {
  const nodes = new Map<string, BrowseNode>();
  for (const tree of trees.values()) {
    for (const node of flatten(tree)) {
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

/**
 * What the selection brings, as far as the loaded trees tell: the ids in
 * the picked collections, and the ids the picked documents bring besides
 * (each with its nested ones). A picked document not loaded counts as
 * itself.
 */
function coverage(picked: Picked, trees: Trees) {
  const nodes = loadedNodes(trees);
  const inContainers = new Set<string>();
  for (const [id, item] of picked) {
    if (item.itemKind === "container") {
      for (const node of flatten(trees.get(id) ?? [])) {
        inContainers.add(node.id);
      }
    }
  }
  const byDocuments = new Set<string>();
  for (const item of picked.values()) {
    if (item.itemKind !== "document") {
      continue;
    }
    const node = nodes.get(item.externalId);
    for (const id of node
      ? flatten([node]).map((n) => n.id)
      : [item.externalId]) {
      if (!inContainers.has(id)) {
        byDocuments.add(id);
      }
    }
  }
  return { byDocuments, inContainers, nodes };
}

/**
 * Drops the excludes nothing brings any more (their collection or
 * document was unchecked): Rust would ignore them, the counter too, but a
 * later pick of that collection must not inherit them. An exclude of a
 * document not loaded is kept: it can't be told.
 */
export function pruneExcludes(picked: Picked, trees: Trees): Picked {
  const { byDocuments, inContainers, nodes } = coverage(picked, trees);
  let next: Map<string, SelectionItem> | undefined;
  for (const [id, item] of picked) {
    const stale =
      item.itemKind === "exclude" &&
      nodes.has(id) &&
      !inContainers.has(id) &&
      !byDocuments.has(id);
    if (stale) {
      next ??= new Map(picked);
      next.delete(id);
    }
  }
  return next ?? picked;
}

/**
 * Toggles a row: a collection, a document, or one that comes with a picked
 * collection or document (left out, or back in). Excludes left without
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
  if (node.kind === "container") {
    next = checked
      ? withItem(picked, itemOf(node, "container"))
      : without(picked, node.id);
  } else if (covered(context)) {
    next = checked
      ? without(picked, node.id)
      : withItem(picked, itemOf(node, "exclude"));
  } else {
    next = checked
      ? withItem(picked, itemOf(node, "document"))
      : without(picked, node.id);
  }
  return pruneExcludes(next, trees);
}

/**
 * How many documents the selection brings, as far as the loaded tree
 * tells: the picked collections' counts, plus what the picked documents
 * bring besides, less the excludes among them. Matches Rust's expansion:
 * an exclude leaves one document out (its nested ones stay); an exclude
 * nothing brings counts for nothing.
 */
export function countDocuments(
  picked: Picked,
  containers: readonly BrowseNode[],
  trees: Trees
): number {
  const { byDocuments, inContainers } = coverage(picked, trees);
  let count = byDocuments.size;
  for (const container of containers) {
    if (picked.get(container.id)?.itemKind === "container") {
      count += container.documentCount;
    }
  }
  for (const [id, item] of picked) {
    if (
      item.itemKind === "exclude" &&
      (inContainers.has(id) || byDocuments.has(id))
    ) {
      count -= 1;
    }
  }
  return Math.max(0, count);
}

/** Nodes whose title has `query`, with the path to them kept. */
export function filterTree(
  nodes: readonly BrowseNode[],
  query: string
): BrowseNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...nodes];
  }
  return nodes.flatMap((node) => {
    if (node.title.toLowerCase().includes(needle)) {
      return [node];
    }
    const children = filterTree(node.children, needle);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}
