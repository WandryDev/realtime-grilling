import { act, renderHook, waitFor } from "@testing-library/react";
import { Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowseNode } from "@/bindings";
import { appRuntime } from "@/effect/runtime";
import { useConnectorContainers, useLazyTree } from "@/features/connectors/api";

/*
 * The picker's reads of a connector's tree (`connector_browse`): a read
 * that was interrupted gave nothing, and must not leave «Загружаем»
 * forever; it is an error with «Повторить», which asks again.
 */

const BROWSE_INTERRUPTED = "Загрузка прервалась";

const space: BrowseNode = {
  children: [],
  documentCount: 0,
  hasChildren: true,
  id: "space:clients",
  kind: "container",
  title: "Клиенты",
  url: null,
};

const list: BrowseNode = {
  ...space,
  documentCount: 1,
  id: "list:lapa",
  title: "Ветклиника Лапа",
};

function answer(...exits: Exit.Exit<unknown, unknown>[]) {
  const spy = vi.spyOn(appRuntime, "runPromiseExit");
  for (const exit of exits) {
    spy.mockResolvedValueOnce(exit as never);
  }
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an interrupted read of the tree", () => {
  it("is an error of the container, and «Повторить» loads it", async () => {
    const spy = answer(Exit.interrupt(), Exit.succeed([list]));
    const { result } = renderHook(() => useLazyTree("clickup"));

    act(() => result.current.load(space));
    await waitFor(() => {
      expect(result.current.errors.get(space.id)).toBe(BROWSE_INTERRUPTED);
    });
    expect(result.current.trees.has(space.id)).toBe(false);

    act(() => result.current.load(space));
    await waitFor(() => {
      expect(result.current.trees.get(space.id)).toEqual([list]);
    });
    expect(result.current.errors.has(space.id)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("is an error of the top level with «Повторить»", async () => {
    answer(Exit.interrupt(), Exit.succeed([space]));
    const { result } = renderHook(() =>
      useConnectorContainers("clickup", true)
    );

    await waitFor(() => {
      expect(result.current.state).toEqual({
        message: BROWSE_INTERRUPTED,
        status: "error",
      });
    });
    act(() => result.current.reload());
    await waitFor(() => {
      expect(result.current.state).toEqual({
        nodes: [space],
        status: "ready",
      });
    });
  });
});
