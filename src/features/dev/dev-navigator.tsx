"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

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
 * from the root layout outside production.
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

export function DevNavigator({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const restartOnboarding = useCallback(() => {
    resetOnboarding();
    setOpen(false);
  }, []);

  return (
    <div
      className={cn(
        "fixed right-4 bottom-4 z-[100] flex flex-col items-end gap-2",
        className
      )}
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
