<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bunx ultracite fix`
- **Check for issues**: `bunx ultracite check`
- **Diagnose setup**: `bunx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns
- Avoid import cycles; move shared code into a module both sides import

### Security

- Add `rel="noopener noreferrer"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bunx ultracite fix` before committing to ensure compliance.

# shadcn components

`packages/ui/src/components/*` (the workspace package `@grill/ui`) are owned, restyled components (the Grill design system), not upstream copies. Grill and the analytics web import them as `@grill/ui/<component>`; the theme is `@grill/ui/theme.css`. `shadcn add` writes there (`components.json` → `ui: @grill/ui`) and must never replace them.

- Preview first: `bunx --bun shadcn@latest add <component> --dry-run` or `--diff`. The dry run marks any existing file that differs from the registry as `~ overwrite`: that is what *would* change, not what `add` does without `-o`.
- Without `-o`, `add` keeps an existing file: it asks "overwrite?" (default No, also with `--yes`). Answer No and port the wanted changes from `--diff` by hand.
- Never run `add` with `-o` / `--overwrite` or `--all`.
- If a file got overwritten anyway, restore it from git: `git restore packages/ui/src/components/<file>`.

# Effect

Backend calls go through [Effect](https://effect.website/) 4 services. Before writing Effect code read `node_modules/effect/AGENTS.md` and the examples it links (the API differs from Effect 3, don't rely on memory).

**Contract types.** Commands, events and records come only from `src/bindings.ts`, which tauri-specta generates from `src-tauri` (`cargo test` or a debug build). Don't edit it and don't copy its types by hand; CI fails when it is stale.

**Bridge.** `src/effect/tauri.ts` is the only way to Rust:
- `call(() => commands.projectsList())` → `Effect<T, BackendError>`, where `BackendError.kind` is `NotFound` / `Invalid` / `Storage` / `Transport` (the IPC itself failed);
- `listen(events.dataChanged)` → `Stream`; the listener is removed when the stream stops, interruption included. For one window, pass `events.x(getCurrentWindow())`.

**Services.** Each is a `Context.Service` with two layers, `layerTauri` (through the bridge) and `layerMock`:
- areas: `src/features/<area>/backend.ts`. Most have only `layerMock` so far (fake timers); the Tauri set reuses it until Rust has the commands;
- data: `src/data/services/*` (`ProjectsData`, `PeopleData`, `CallsData`, `SettingsData`, `DataEvents`). Their `layerMock` is an in-memory repository (`MockDatabase`) with the Rust contract: UUID v7 ids, `NotFound` / `Invalid`, cascade deletes, one `DataChanged` per write. `src/__tests__/data-contract.test.ts` holds the contract; change it together with the Rust storage tests.

**Composition.** `src/effect/runtime.ts` builds `MockLayer` and `TauriLayer` and picks one by `isTauri()` when it loads (`inTauri`; `false` in the browser, the tests and the prerender). React code runs effects with `runCancelable` / `appRuntime.runPromise`; screens don't import Effect.

**Stores.** `src/data/*` keep their hooks and actions; the entity stores sit on `createSyncedStore` (`src/data/synced-store.ts`) over the data services:
- mock: seeded synchronously from `src/data/services/mock-seed.ts`. A write runs synchronously and is in the store before the action returns, then every mock store re-reads (the cascade). Screen tests never wait;
- Tauri: the store starts in `loading` and reads on its first subscriber. It re-reads on `DataChanged` from any window: its own entity, and children by `projectId` when the parent changes. A write waits for the command and re-reads; a failed one shows a toast and leaves the store as the storage has it. Actions that create resolve to the backend id (`createProject` → UUID), never a slug;
- every store maps backend shapes (JSON `profile` / `summary`, timestamps in ms) to the screens' types in its own adapter section, and only there;
- the main window (`src/features/shell/app-frame.tsx`) waits for the first read, shows a full-window error on a failed one (`Storage`), and opens the routes of `events.navigate`.

**Errors and tests.** Errors are `Schema.TaggedError`, handled with `Effect.catchTag` at the edge. Test services with `@effect/vitest` (`it.effect`, `TestClock`). To run screens in Tauri mode, mock the IPC with `src/__tests__/helpers/fake-tauri.ts` (see `tauri-stores.test.tsx`).
