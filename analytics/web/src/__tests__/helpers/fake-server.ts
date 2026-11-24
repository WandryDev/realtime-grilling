// The server as the pages see it in tests: `fetch` answers the API's paths
// from `routes`, and `EventSource` is a fake the test sends changes through.

import { act } from "@testing-library/react";

/** What `GET <path>` answers; a missing path is a 404. */
export const routes = new Map<string, unknown>();

export const serve = (entries: Record<string, unknown>) => {
  routes.clear();
  for (const [path, body] of Object.entries(entries)) {
    routes.set(path, body);
  }
};

const answer = (input: RequestInfo | URL): Response => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = routes.get(url.pathname);
  if (body === undefined) {
    // As the server answers a read of what it does not have.
    return new Response(JSON.stringify({ _tag: "NotFound" }), {
      headers: { "content-type": "application/json" },
      status: 404,
    });
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
};

globalThis.fetch = Object.assign(
  (input: RequestInfo | URL) => Promise.resolve(answer(input)),
  { preconnect: () => undefined }
);

type Listener = (event: Event) => void;

/** The live stream of a page; `sources` are the ones open now. */
export class FakeEventSource {
  static readonly sources = new Set<FakeEventSource>();
  readonly url: string;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.sources.add(this);
    queueMicrotask(() => this.dispatch("open"));
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  close() {
    FakeEventSource.sources.delete(this);
  }

  dispatch(type: string) {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

/** The server says that what the open pages watch changed. */
export const change = () =>
  act(() => {
    for (const source of FakeEventSource.sources) {
      source.dispatch("change");
    }
  });
