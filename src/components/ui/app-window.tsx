import { cn } from "cn"

/*
 * Paper "10 Окна и оболочки", "Окно": the app window is the surface gray
 * with a 26px radius and a hairline outline, a 56px WindowTitlebar on top and
 * the white panel inside. The panel (radius 20, card shadow) keeps 8px from
 * the window edges; the sidebar, if any, sits on the gray next to it.
 *
 * In Tauri the window itself is transparent and undecorated, AppWindow fills
 * it and draws the rounded shape.
 *
 *   <AppWindow>
 *     <WindowTitlebar>…</WindowTitlebar>
 *     <AppWindowBody>
 *       <aside>…navigation…</aside>
 *       <AppWindowPanel>…main content…</AppWindowPanel>
 *     </AppWindowBody>
 *   </AppWindow>
 */
function AppWindow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-window"
      className={cn(
        "flex flex-col overflow-clip rounded-lg bg-surface ring-1 ring-foreground/6",
        className
      )}
      {...props}
    />
  )
}

function AppWindowBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-window-body"
      className={cn("flex min-h-0 flex-1 gap-2 px-2 pb-2", className)}
      {...props}
    />
  )
}

/**
 * The white panel with the main content. Padding is up to the content. It is
 * a div: wrap the page content in `<main>` yourself.
 */
function AppWindowPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-window-panel"
      className={cn(
        "flex min-w-0 flex-1 flex-col rounded-panel bg-background shadow-card",
        className
      )}
      {...props}
    />
  )
}

export { AppWindow, AppWindowBody, AppWindowPanel }
