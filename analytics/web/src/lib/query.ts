"use client";

// A read that keeps its data on screen while it reads again: a live change
// never empties the page or moves what is being read.

import type { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Client, isNotFound, read } from "./api";
import { type Connection, useLive, type Watch } from "./live";

export type Query<A> =
  | { readonly status: "loading" }
  | { readonly status: "notFound" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly retry: () => void;
    }
  | { readonly status: "ready"; readonly data: A };

export const useQuery = <A, E>(
  key: string,
  load: (api: Client) => Effect.Effect<A, E>,
  watch: Watch | null
): { connection: Connection; query: Query<A> } => {
  const [query, setQuery] = useState<Query<A>>({ status: "loading" });
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);

  const run = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    read(loader.current).then(
      (data) => {
        if (mine === generation.current) {
          setQuery({ data, status: "ready" });
        }
      },
      (error: unknown) => {
        if (mine !== generation.current) {
          return;
        }
        setQuery((previous) => {
          // A live re-read that failed keeps what is on screen.
          if (previous.status === "ready") {
            return previous;
          }
          if (isNotFound(error)) {
            return { status: "notFound" };
          }
          return { message: String(error), retry: run, status: "error" };
        });
      }
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` reads
  useEffect(() => {
    setQuery({ status: "loading" });
    run();
  }, [key, run]);

  const connection = useLive(watch, run);
  return { connection, query };
};
