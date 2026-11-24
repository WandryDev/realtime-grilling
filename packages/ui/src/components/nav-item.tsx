import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "cn"

/*
 * Paper "10 Окна и оболочки", "Пункт боковой навигации". The sidebar sits on
 * the window's surface gray. An item is a 34px pill: 16px icon, 14px label,
 * an optional marker on the right (count, recording dot, error icon).
 * Muted by default, hairline gray on hover, the current page is a white pill
 * with the touch shadow and a medium label.
 *
 *   <NavMenu aria-label="Разделы">
 *     <NavItem active href="/calls">
 *       <PhoneIcon />
 *       <NavItemLabel>Звонки</NavItemLabel>
 *       <NavItemRecording />
 *     </NavItem>
 *     <NavItem href="/projects">
 *       <ProjectsIcon />
 *       <NavItemLabel>Проекты</NavItemLabel>
 *       <Counter variant="neutral">4</Counter>
 *     </NavItem>
 *   </NavMenu>
 *
 * NavItem is a link; pass `render={<Link href="…" />}` for Next.js links or
 * `render={<button type="button" />}` for in-app state.
 */
function NavMenu({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="nav-menu"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  )
}

type NavItemProps = useRender.ComponentProps<"a"> & {
  /** The current page: white pill, `aria-current="page"`. */
  active?: boolean
}

function NavItem({ className, active = false, render, ...props }: NavItemProps) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        className: cn(
          "flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-full px-2.5 text-base text-muted-foreground transition-colors outline-none select-none",
          "not-data-active:hover:bg-border hover:text-foreground focus-visible:focus-ring focus-visible:text-foreground",
          "data-active:bg-background data-active:font-medium data-active:text-foreground data-active:shadow-touch",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "nav-item",
      active,
    },
  })
}

function NavItemLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="nav-item-label"
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  )
}

/** Red 6px dot: a call is being recorded right now. */
function NavItemRecording({
  className,
  label = "идёт запись",
  ...props
}: React.ComponentProps<"span"> & { label?: string }) {
  return (
    <span
      data-slot="nav-item-recording"
      className={cn("flex shrink-0 items-center", className)}
      {...props}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-recording" />
      <span className="sr-only">, {label}</span>
    </span>
  )
}

/** Red "!" in a circle: something in this section needs attention. */
function NavItemError({
  className,
  "aria-label": ariaLabel = "ошибка",
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="nav-item-error"
      role="img"
      aria-label={ariaLabel}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={cn("size-3.5 shrink-0 text-destructive", className)}
      {...props}
    >
      <circle cx="7" cy="7" r="5.75" />
      <path d="M7 4.25V7.5" />
      <circle cx="7" cy="9.75" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export { NavItem, NavItemError, NavItemLabel, NavItemRecording, NavMenu }
export type { NavItemProps }
