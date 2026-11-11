import { describe, expect, it, it as test } from "vitest";

import type { SelectionItem } from "@/bindings";
import {
  countDocuments,
  countSelection,
  nestedContext,
  type Picked,
  pickedFrom,
  type RowContext,
  rowState,
  rulesOf,
  type Trees,
  toggle,
  toItems,
} from "@/features/connectors/selection";

import { fakeNode } from "./helpers/fake-tauri";

/*
 * The picker's selection rules against Rust's expansion
 * (`connectors::outline::resolve`): an exclude leaves one document out of
 * whatever brings it (a picked collection or a picked document), its
 * nested ones stay; an exclude nothing brings changes nothing. The counter
 * must equal what a sync loads, so the cases below are those of
 * `a_document_brings_its_nested_ones_and_excludes_stay_out` in
 * src-tauri/src/connectors/outline/tests.rs.
 */

// tm: tm-1 (child (grandchild)), tm-2 (other-child); dc: dc-1.
const grandchild = fakeNode("grandchild", "Внук");
const child = fakeNode("child", "Ребёнок", "document", [grandchild]);
const tm1 = fakeNode("tm-1", "Первый", "document", [child]);
const otherChild = fakeNode("other-child", "Другой ребёнок");
const tm2 = fakeNode("tm-2", "Второй", "document", [otherChild]);
const dc1 = fakeNode("dc-1", "Документ");
const tmTree = [tm1, tm2];
const tm = {
  ...fakeNode("tm", "Телемедиа", "container", tmTree),
  children: [],
};
const dc = { ...fakeNode("dc", "Документы", "container", [dc1]), children: [] };
const containers = [tm, dc];
const trees: Trees = new Map([
  ["tm", tmTree],
  ["dc", [dc1]],
]);

const TOP: RowContext = { inPickedContainer: false, inPickedDocument: false };
const IN_CONTAINER: RowContext = {
  inPickedContainer: true,
  inPickedDocument: false,
};
const IN_DOCUMENT: RowContext = {
  inPickedContainer: false,
  inPickedDocument: true,
};

function item(
  itemKind: SelectionItem["itemKind"],
  externalId: string
): SelectionItem {
  return { externalId, itemKind, title: externalId, url: null };
}

function picked(...items: SelectionItem[]): Picked {
  return new Map(items.map((entry) => [entry.externalId, entry]));
}

function ids(selection: Picked) {
  return toItems(selection).map(
    (entry) => `${entry.itemKind}:${entry.externalId}`
  );
}

describe("the counter equals Rust's expansion", () => {
  it.each([
    ["a document with its nested ones", [item("document", "tm-1")], 3],
    [
      "a collection less one, its nested one stays",
      [item("container", "tm"), item("exclude", "child")],
      4,
    ],
    [
      "a picked document less a nested one",
      [item("document", "tm-1"), item("exclude", "child")],
      2,
    ],
    [
      "an exclude nothing brings counts for nothing",
      [item("document", "tm-2"), item("exclude", "child")],
      2,
    ],
    [
      "a document inside a picked collection is not counted twice",
      [item("document", "tm-1"), item("container", "tm")],
      5,
    ],
    [
      "nested picks are counted once",
      [item("document", "child"), item("document", "tm-1")],
      3,
    ],
  ])("%s", (_name, items, expected) => {
    expect(countDocuments(picked(...items), containers, trees)).toBe(expected);
  });
});

describe("unchecking drops the excludes it leaves behind", () => {
  it("a collection takes its excludes along", () => {
    let selection = picked(item("container", "tm"));
    selection = toggle(selection, child, IN_CONTAINER, false, trees);
    expect(ids(selection)).toEqual(["container:tm", "exclude:child"]);
    expect(countDocuments(selection, containers, trees)).toBe(4);

    selection = toggle(selection, tm, TOP, false, trees);
    expect(ids(selection)).toEqual([]);
    // A document of it picked now brings its nested one: checked and
    // counted, as Rust loads it.
    selection = toggle(selection, tm1, TOP, true, trees);
    expect(rowState(selection, child, IN_DOCUMENT).checked).toBe(true);
    expect(countDocuments(selection, containers, trees)).toBe(3);
  });

  it("a document takes the excludes of its nested ones along", () => {
    let selection = toggle(picked(), tm1, TOP, true, trees);
    selection = toggle(selection, child, IN_DOCUMENT, false, trees);
    expect(ids(selection)).toEqual(["document:tm-1", "exclude:child"]);
    expect(rowState(selection, child, IN_DOCUMENT).checked).toBe(false);
    expect(countDocuments(selection, containers, trees)).toBe(2);

    selection = toggle(selection, tm1, TOP, false, trees);
    expect(ids(selection)).toEqual([]);
  });

  it("keeps an exclude still brought by another pick", () => {
    const selection = toggle(
      picked(
        item("container", "tm"),
        item("document", "tm-1"),
        item("exclude", "child")
      ),
      tm1,
      IN_CONTAINER,
      false,
      trees
    );
    expect(ids(selection)).toEqual([
      "container:tm",
      "exclude:tm-1",
      "exclude:child",
    ]);
  });

  it("keeps an exclude of a document not loaded", () => {
    const selection = pickedFrom([
      {
        externalId: "unknown",
        itemKind: "exclude",
        otherAccount: false,
        status: "ok",
        title: "Не загружен",
        url: null,
      },
    ]);
    expect(ids(toggle(selection, dc, TOP, true, trees))).toEqual([
      "exclude:unknown",
      "container:dc",
    ]);
  });
});

test("a nested document of a picked one can be left out and back in", () => {
  let selection = picked(item("document", "tm-1"));
  expect(rowState(selection, grandchild, IN_DOCUMENT).checked).toBe(true);
  selection = toggle(selection, grandchild, IN_DOCUMENT, false, trees);
  expect(rowState(selection, grandchild, IN_DOCUMENT).checked).toBe(false);
  selection = toggle(selection, grandchild, IN_DOCUMENT, true, trees);
  expect(ids(selection)).toEqual(["document:tm-1"]);
});

/*
 * ClickUp (connectors-clickup design.md, decisions 2 and 3): containers
 * nest, a container left out takes its tasks along, a task left out takes
 * its subtasks along, a task picked by itself comes anyway.
 */
describe("nested containers and ClickUp's excludes", () => {
  const rules = rulesOf("clickup");
  const sub = fakeNode("sub", "Подзадача");
  const parent = fakeNode("parent", "Задача", "document", [sub]);
  const other = fakeNode("other", "Другая");
  const listA = {
    ...fakeNode("list:a", "Список А", "container"),
    documentCount: 3,
    hasChildren: true,
  };
  const listB = {
    ...fakeNode("list:b", "Список Б", "container"),
    documentCount: 4,
    hasChildren: true,
  };
  const folder = fakeNode("folder:f", "Папка", "container", [listA]);
  const space = {
    ...fakeNode("space:s", "Пространство", "container"),
    documentCount: 0,
    hasChildren: true,
  };
  const spaces = [space];
  const loaded: Trees = new Map([
    ["space:s", [folder, listB]],
    ["list:a", [parent, other]],
  ]);

  it("counts a picked space by its lists, less a list left out", () => {
    expect(
      countSelection(
        picked(item("container", "space:s")),
        spaces,
        loaded,
        rules
      )
    ).toEqual({ approximate: false, count: 7 });
    expect(
      countSelection(
        picked(item("container", "space:s"), item("exclude", "list:b")),
        spaces,
        loaded,
        rules
      ).count
    ).toBe(3);
  });

  it("is approximate while a picked space is not loaded", () => {
    expect(
      countSelection(picked(item("container", "space:s")), spaces, new Map())
    ).toEqual({ approximate: true, count: 0 });
  });

  it("leaves a task out with its subtasks", () => {
    const selection = picked(
      item("container", "list:a"),
      item("exclude", "parent")
    );
    expect(countSelection(selection, spaces, loaded, rules).count).toBe(1);
    expect(
      rowState(selection, sub, nestedContext(IN_CONTAINER, false, rules))
        .checked
    ).toBe(false);
  });

  it("checks a list inside a picked space and leaves it out on uncheck", () => {
    const selection = toggle(
      picked(item("container", "space:s")),
      listB,
      IN_CONTAINER,
      false,
      loaded
    );
    expect(ids(selection)).toEqual(["container:space:s", "exclude:list:b"]);
    expect(ids(toggle(selection, space, TOP, false, loaded))).toEqual([]);
  });
});
