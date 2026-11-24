"use client"

import * as React from "react"
import { cn } from "cn"

/*
 * Motion for what arrives while a screen is open: a question the agent
 * suggests, a finding, a panel over the call. What is already on the screen
 * when it opens stays still; only what mounts later plays its entrance.
 *
 *   <AppearScope>…</AppearScope>     a screen whose content arrives live
 *   const entering = useAppear()     mounted after the scope's first render
 *   <Appear motion="drop">…</Appear> a block that plays its entrance
 *
 * Entrances are tw-animate keyframes on transform and opacity, so they never
 * move the layout. Under reduced motion globals.css zeroes their travel and
 * leaves the fade.
 */

const AppearContext = React.createContext(false)

/** Content present at its first render stays still; later arrivals enter. */
function AppearScope({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => setReady(true), [])
  return <AppearContext value={ready}>{children}</AppearContext>
}

/**
 * True when the component mounted after its scope's first render, fixed for
 * its life. Outside a scope (previews, /dev) it is always false.
 */
function useAppear(): boolean {
  const ready = React.useContext(AppearContext)
  const [entering] = React.useState(ready)
  return entering
}

/*
 * The entrances, 200ms on the enter curve (ease-out-quint, the message
 * scroller's):
 * - rise: 4px up into place, for rows added under what is there;
 * - drop: 4px down into place, for things inserted at the top or under a
 *   pill;
 * - pop: from 97% scale, for panels over the window.
 */
const APPEAR_MOTION = {
  rise: "data-entering:slide-in-from-bottom-1",
  drop: "data-entering:slide-in-from-top-1",
  pop: "data-entering:zoom-in-97",
} as const

type AppearMotion = keyof typeof APPEAR_MOTION

function appearClassName(motion: AppearMotion) {
  return cn(
    "data-entering:animate-in data-entering:fade-in-0 data-entering:duration-200 data-entering:ease-enter",
    APPEAR_MOTION[motion]
  )
}

/**
 * A block that enters when it arrives. Its children arrive with it: they
 * start a new scope, so they don't play entrances of their own.
 */
function Appear({
  className,
  children,
  motion = "rise",
  ...props
}: React.ComponentProps<"div"> & { motion?: AppearMotion }) {
  const entering = useAppear()
  return (
    <div
      data-slot="appear"
      data-entering={entering ? "" : undefined}
      className={cn(appearClassName(motion), className)}
      {...props}
    >
      <AppearScope>{children}</AppearScope>
    </div>
  )
}

type Presence<T> = { item: T; key: string; leaving: boolean }

/*
 * A keyed list whose removed items stay a moment to play their exit: they
 * keep their place, marked `leaving`, until `exited(key)`. An item that comes
 * back while leaving simply stays.
 */
function usePresence<T>(
  items: readonly T[],
  getKey: (item: T) => string
): { list: Presence<T>[]; exited: (key: string) => void } {
  const [list, setList] = React.useState(() =>
    items.map((item) => ({ item, key: getKey(item), leaving: false }))
  )
  const [shown, setShown] = React.useState(items)

  // Derived during render, so a removed row never flashes out for a frame
  if (shown !== items) {
    setShown(items)
    setList(mergePresence(list, items, getKey))
  }

  const exited = React.useCallback((key: string) => {
    setList((current) =>
      current.filter((entry) => !(entry.leaving && entry.key === key))
    )
  }, [])

  return { list, exited }
}

function mergePresence<T>(
  previous: Presence<T>[],
  items: readonly T[],
  getKey: (item: T) => string
): Presence<T>[] {
  const next = items.map((item) => ({ item, key: getKey(item), leaving: false }))
  const present = new Set(next.map((entry) => entry.key))
  previous.forEach((entry, index) => {
    if (present.has(entry.key)) {
      return
    }
    // Right after the nearest earlier neighbour that is still in the list
    let at = 0
    for (let before = index - 1; before >= 0; before -= 1) {
      const neighbour = next.findIndex(
        (candidate) => candidate.key === previous[before].key
      )
      if (neighbour !== -1) {
        at = neighbour + 1
        break
      }
    }
    next.splice(at, 0, { ...entry, leaving: true })
  })
  return next
}

/**
 * Calls `onExited` once the element's exit keyframes are over, or at once
 * when there are none (animations off, jsdom). Transitions on the element
 * (a hover background letting go) don't hold the exit up.
 */
function useExitEnd(
  ref: React.RefObject<HTMLElement | null>,
  leaving: boolean,
  onExited: (() => void) | undefined
) {
  const latest = React.useRef(onExited)
  React.useLayoutEffect(() => {
    latest.current = onExited
  })

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!(leaving && element)) {
      return
    }
    const keyframes = (element.getAnimations?.() ?? []).filter(
      (animation) => "animationName" in animation
    )
    if (keyframes.length === 0) {
      latest.current?.()
      return
    }
    let cancelled = false
    // Settled, not fulfilled: a cancelled animation still ends the exit
    Promise.allSettled(keyframes.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) {
          latest.current?.()
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [leaving, ref])
}

const SLIDE_MS = 200
const SLIDE_EASE = "cubic-bezier(0.23, 1, 0.32, 1)"

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  )
}

/** Vertical offset of a running slide, from the computed `translate`. */
function currentOffset(element: HTMLElement) {
  const value = getComputedStyle(element).translate
  if (!value || value === "none") {
    return 0
  }
  const [, y = "0"] = value.split(" ")
  return Number.parseFloat(y) || 0
}

/*
 * When an item is inserted or removed above, the items of the container
 * that moved slide to their new place instead of jumping (FLIP on the
 * `translate` property, 200ms on the enter curve). The container must be
 * `relative`, so its children's offsetTop is measured from it. Skipped
 * under reduced motion.
 */
function useSlideIntoPlace(ref: React.RefObject<HTMLElement | null>) {
  const tops = React.useRef(new WeakMap<Element, number>())
  const slides = React.useRef(new WeakMap<Element, Animation>())

  React.useLayoutEffect(() => {
    const container = ref.current
    if (!container) {
      return
    }
    const still = prefersReducedMotion()
    for (const child of container.children) {
      if (!(child instanceof HTMLElement)) {
        continue
      }
      const top = child.offsetTop
      const before = tops.current.get(child)
      tops.current.set(child, top)
      if (before === undefined || still || typeof child.animate !== "function") {
        continue
      }
      const running = slides.current.get(child)
      const moved = before - top
      if (moved === 0) {
        continue
      }
      // Start from where it is drawn now, even halfway through a slide
      const from = moved + (running ? currentOffset(child) : 0)
      running?.cancel()
      slides.current.set(
        child,
        child.animate(
          [{ translate: `0 ${from}px` }, { translate: "0 0" }],
          { duration: SLIDE_MS, easing: SLIDE_EASE }
        )
      )
    }
  })
}

export {
  Appear,
  AppearScope,
  appearClassName,
  useAppear,
  useExitEnd,
  usePresence,
  useSlideIntoPlace,
}
export type { AppearMotion, Presence }
