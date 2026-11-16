import type { ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeftIcon } from "./icons";

/*
 * Footer actions of the onboarding steps.
 *
 *   <OnboardingFooter
 *     start={<OnboardingBackButton />}
 *     end={
 *       <>
 *         <OnboardingFooterHint>Сначала разрешите оба доступа</OnboardingFooterHint>
 *         <OnboardingNextButton disabled />
 *       </>
 *     }
 *   />
 */

/** "Назад": a muted text pill with a chevron. */
export function OnboardingBackButton({
  children = "Назад",
  className,
  ...props
}: Omit<ButtonProps, "size" | "variant">) {
  return (
    <Button
      className={cn("gap-1.5 pr-3.5 pl-2.5", className)}
      size="lg"
      variant="ghost"
      {...props}
    >
      <ChevronLeftIcon className="size-3.5" />
      {children}
    </Button>
  );
}

/*
 * The step's main action, "Продолжить" by default. While the step isn't
 * done it is disabled and turns gray with subtle text instead of a faded
 * black pill.
 */
export function OnboardingNextButton({
  children = "Продолжить",
  className,
  ...props
}: Omit<ButtonProps, "size" | "variant">) {
  return (
    <Button
      className={cn(
        "data-disabled:bg-surface data-disabled:text-subtle px-5 data-disabled:not-data-loading:opacity-100",
        className
      )}
      size="lg"
      {...props}
    >
      {children}
    </Button>
  );
}

/** Why the main action is unavailable, or how long the step takes. */
export function OnboardingFooterHint({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-muted-foreground pr-2 text-sm", className)}>
      {children}
    </p>
  );
}
