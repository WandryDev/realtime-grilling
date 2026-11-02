import type { ReactNode } from "react";

/*
 * One artboard from Paper at its native size, with its name above. Screens
 * fill the frame (`size-full` on the window). Pass `height="auto"` for
 * artboards that grow with their content.
 */
export function ScreenFrame({
  children,
  height,
  id,
  note,
  title,
  width,
}: {
  children: ReactNode;
  height: number | "auto";
  id: string;
  /** What the state shows, from the Paper notes. */
  note?: string;
  title: string;
  width: number;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-20 flex-col gap-4"
      id={id}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold" id={`${id}-title`}>
          {title}
        </h2>
        {note ? (
          <p className="text-muted-foreground max-w-content text-sm">{note}</p>
        ) : null}
      </header>
      <div className="overflow-x-auto pb-2">
        <div
          className="relative isolate shrink-0"
          style={{ height: height === "auto" ? undefined : height, width }}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/** Page of one flow: title, anchor list of its screens, the frames. */
export function ScreenFlow({
  children,
  screens,
  title,
}: {
  children: ReactNode;
  screens: { id: string; title: string }[];
  title: string;
}) {
  return (
    <div className="min-h-svh">
      <header className="border-border bg-background/90 sticky top-0 z-20 border-b backdrop-blur">
        <div className="flex items-center gap-6 px-16 py-3">
          <a
            className="text-muted-foreground hover:text-foreground focus-visible:focus-ring shrink-0 rounded-full text-sm"
            href="/dev/screens"
          >
            Все экраны
          </a>
          <p className="shrink-0 text-base font-semibold">{title}</p>
          <nav
            aria-label="Экраны"
            className="flex min-w-0 gap-1 overflow-x-auto py-1"
          >
            {screens.map((screen) => (
              <a
                className="text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:focus-ring shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
                href={`#${screen.id}`}
                key={screen.id}
              >
                {screen.title}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="flex flex-col gap-20 px-16 py-12">{children}</main>
    </div>
  );
}
