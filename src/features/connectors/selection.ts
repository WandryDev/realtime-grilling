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

/**
 * Where the nested rows of a document sit. A document left out of a
 * collection goes alone (as in Rust): its nested ones stay picked.
 */
export function nestedContext(
  context: RowContext,
  checked: boolean
): RowContext {
  if (context.inPickedDocument || context.inPickedContainer) {
    return context;
  }
  return { inPickedContainer: false, inPickedDocument: checked };
}

/** Whether a row's box is checked, and whether it can change. */
export function rowState(
  picked: Picked,
  node: BrowseNode,
  context: RowContext
): { checked: boolean; locked: boolean } {
  const item = picked.get(node.id);
  if (node.kind === "container") {
    return { checked: item?.itemKind === "container", locked: false };
  }
  if (context.inPickedDocument) {
    return { checked: true, locked: true };
  }
  if (context.inPickedContainer) {
    return { checked: item?.itemKind !== "exclude", locked: false };
  }
  return { checked: item?.itemKind === "document", locked: false };
}

/** Toggles a row: a collection, a document, or one left out of a collection. */
export function toggle(
  picked: Picked,
  node: BrowseNode,
  context: RowContext,
  checked: boolean
): Picked {
  if (node.kind === "container") {
    return checked
      ? withItem(picked, itemOf(node, "container"))
      : without(picked, node.id);
  }
  if (context.inPickedContainer) {
    return checked
      ? without(picked, node.id)
      : withItem(picked, itemOf(node, "exclude"));
  }
  return checked
    ? withItem(picked, itemOf(node, "document"))
    : without(picked, node.id);
}

/** Every node of a tree, its nested ones included. */
function flatten(nodes: readonly BrowseNode[]): BrowseNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** The loaded nodes of every collection, by id. */
function loadedNodes(trees: ReadonlyMap<string, readonly BrowseNode[]>) {
  const nodes = new Map<string, BrowseNode>();
  for (const tree of trees.values()) {
    for (const node of flatten(tree)) {
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

/** Documents of the picked collections, and their ids. */
function pickedContainers(
  picked: Picked,
  containers: readonly BrowseNode[],
  trees: ReadonlyMap<string, readonly BrowseNode[]>
) {
  let count = 0;
  const ids = new Set<string>();
  for (const container of containers) {
    if (picked.get(container.id)?.itemKind === "container") {
      count += container.documentCount;
      for (const node of flatten(trees.get(container.id) ?? [])) {
        ids.add(node.id);
      }
    }
  }
  return { count, ids };
}

/**
 * How many documents the selection brings, as far as the loaded tree
 * tells: a collection's count less what is left out, plus the picked
 * documents outside the picked collections, each with its nested ones.
 */
export function countDocuments(
  picked: Picked,
  containers: readonly BrowseNode[],
  trees: ReadonlyMap<string, readonly BrowseNode[]>
): number {
  const nodes = loadedNodes(trees);
  const { count: inContainers, ids: counted } = pickedContainers(
    picked,
    containers,
    trees
  );
  let count = inContainers;
  for (const item of picked.values()) {
    const node = nodes.get(item.externalId);
    const size = node?.documentCount ?? 1;
    if (item.itemKind === "exclude") {
      // A document left out goes alone, its nested ones stay.
      count -= 1;
    } else if (item.itemKind === "document" && !counted.has(item.externalId)) {
      count += size;
      for (const nested of flatten(node ? [node] : [])) {
        counted.add(nested.id);
      }
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
