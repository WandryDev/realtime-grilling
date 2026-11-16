/*
 * Serves the static export in `out/` the way Tauri does: `/path` resolves
 * to `/path.html`, `/path/` to `/path/index.html`. Used by Playwright
 * (`playwright.config.ts`); the port comes from `PORT` (default 4173).
 *
 *   bun scripts/serve-out.ts
 */

import { join, normalize, sep } from "node:path";
import { type BunFile, file, serve } from "bun";

const DEFAULT_PORT = 4173;
const ROOT = join(import.meta.dir, "..", "out");
const port = Number(process.env.PORT ?? DEFAULT_PORT);

/** Files to try for a URL path, most specific first. */
function candidates(pathname: string): string[] {
  if (pathname.endsWith("/")) {
    return [`${pathname}index.html`];
  }
  return [pathname, `${pathname}.html`, `${pathname}/index.html`];
}

/** A regular file inside `out/`; a directory (`/project` next to `project.html`) is not. */
async function regularFile(candidate: string): Promise<BunFile | null> {
  const path = normalize(join(ROOT, candidate));
  // `..` in the URL must not escape `out/`.
  if (!path.startsWith(ROOT + sep)) {
    return null;
  }
  try {
    const stat = await file(path).stat();
    return stat.isFile() ? file(path) : null;
  } catch {
    return null;
  }
}

async function resolve(pathname: string): Promise<BunFile | null> {
  const files = await Promise.all(candidates(pathname).map(regularFile));
  return files.find((found) => found !== null) ?? null;
}

const server = serve({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const found = await resolve(decodeURIComponent(pathname));
    if (found) {
      return new Response(found);
    }
    return new Response(file(join(ROOT, "404.html")), { status: 404 });
  },
  port,
});

process.stdout.write(`Serving out/ at ${server.url}\n`);
