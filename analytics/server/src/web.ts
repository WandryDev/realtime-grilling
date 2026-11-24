// The web of the analytics (`analytics/web`, a static export) from the same
// server: one address, no CORS (call-analytics design.md, decision 9).
// `WEB_DIR` is the export's folder; without it only the API answers.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** `../` at the start of a path: never above the export. */
const PARENTS = /^(?:\.\.(?:\/|\\|$))+/u;

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** The file of `pathname` in `dir`: as it is, as a page (`.html`), or its
 * folder's `index.html`; never outside `dir`. */
export const fileOf = (root: string, pathname: string): string | null => {
  const relative = normalize(decodeURIComponent(pathname)).replace(PARENTS, "");
  const base = join(root, relative);
  if (!base.startsWith(normalize(root))) {
    return null;
  }
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
};

const serve = (root: string) =>
  HttpRouter.add("GET", "/*", (request) =>
    Effect.sync(() => {
      const { pathname } = new URL(request.url, "http://localhost");
      const file = fileOf(root, pathname) ?? fileOf(root, "/404");
      if (!file) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(readFileSync(file), {
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
        status: file.endsWith("404.html") && pathname !== "/404" ? 404 : 200,
      });
    })
  );

const dir = process.env.WEB_DIR;

export const WebRoutes = dir && existsSync(dir) ? serve(dir) : Layer.empty;
