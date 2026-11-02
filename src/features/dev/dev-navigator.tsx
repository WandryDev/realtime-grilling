"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { resetOnboarding } from "@/data/onboarding";
import { callDemo } from "@/features/call/demo";
import { callWidgetDemo } from "@/features/call-widget/demo";
import { onboardingDemo } from "@/features/onboarding/demo";
import { onboardingIntegrationsDemo } from "@/features/onboarding/integrations/demo";
import { postCallDemo } from "@/features/post-call/demo";
import { projectsDemo } from "@/features/projects/demo";
import { settingsDemo } from "@/features/settings/demo";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/*
 * Development-only jump list: every screen and every state that the mock
 * data can't reach by clicking (errors, empty states, flow steps). Rendered
 * from the root layout outside production, bottom left: the main actions of
 * every window live bottom right. Not in the floating windows (widget,
 * overlay), which are only as big as their card.
 */

const GROUPS = [
  onboardingDemo,
  onboardingIntegrationsDemo,
  projectsDemo,
  callWidgetDemo,
  callDemo,
  postCallDemo,
  settingsDemo,
];

const CATALOG = [
  { href: "/dev", label: "Дизайн-система" },
  { href: "/dev/screens", label: "Все экраны на одной странице" },
];

const FLOATING_WINDOW = '[data-window="floating"]';

/** Re-checks on every DOM change: client navigation swaps the page. */
function subscribeToDom(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    attributeFilter: ["data-window"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function hasFloatingWindow() {
  return document.querySelector(FLOATING_WINDOW) !== null;
}

function noFloatingWindowOnServer() {
  return false;
}

/** Whether the page is a floating window (`data-window="floating"`). */
function useFloatingWindow() {
  return useSyncExternalStore(
    subscribeToDom,
    hasFloatingWindow,
    noFloatingWindowOnServer
  );
}

export function DevNavigator({ className }: { className?: string }) {
  const floating = useFloatingWindow();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const restartOnboarding = useCallback(() => {
    resetOnboarding();
    setOpen(false);
  }, []);

  if (floating) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed bottom-4 left-4 z-[100] flex flex-col items-start gap-2",
        className
      )}
      data-slot="dev-navigator"
    >
      {open ? (
        <nav
          aria-label="Экраны приложения"
          className="bg-background shadow-float flex max-h-[70svh] w-80 flex-col gap-4 overflow-y-auto rounded-md p-4"
          id="dev-navigator"
        >
          {GROUPS.filter((group) => group.links.length > 0).map((group) => (
            <section className="flex flex-col gap-1" key={group.title}>
              <h2 className="text-muted-foreground px-2 text-xs font-medium">
                {group.title}
              </h2>
              {group.links.map((link) => (
                <Link
                  className="hover:bg-surface focus-visible:focus-ring rounded-xs px-2 py-1 text-sm transition-colors"
                  href={link.href}
                  key={link.href}
                  onClick={close}
                >
                  {link.label}
                </Link>
              ))}
            </section>
          ))}
          <section className="border-border flex flex-col gap-1 border-t pt-3">
            {CATALOG.map((link) => (
              <Link
                className="hover:bg-surface focus-visible:focus-ring rounded-xs px-2 py-1 text-sm transition-colors"
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            ))}
            <Link
              className="hover:bg-surface focus-visible:focus-ring rounded-xs px-2 py-1 text-sm transition-colors"
              href={routes.onboarding()}
              onClick={restartOnboarding}
            >
              Пройти настройку заново
            </Link>
          </section>
        </nav>
      ) : null}
      <Button
        aria-controls="dev-navigator"
        aria-expanded={open}
        onClick={toggle}
        size="sm"
        variant="secondary"
      >
        {open ? "Закрыть" : "Экраны"}
      </Button>
    </div>
  );
}
