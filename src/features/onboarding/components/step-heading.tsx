import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * Title and lead of an onboarding step: 28px semibold title over a 16px
 * muted paragraph, 10px apart. `size="hero"` is the 40px title of the
 * welcome screen.
 */
export function StepHeading({
  className,
  description,
  size = "default",
  title,
  ...props
}: Omit<ComponentProps<"header">, "title"> & {
  description?: ReactNode;
  size?: "default" | "hero";
  title: ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-2.5", className)} {...props}>
      <h1
        className={cn(
          "font-semibold tracking-tight text-balance",
          size === "hero" ? "text-3xl" : "text-2xl"
        )}
      >
        {title}
      </h1>
      {description ? (
        <p className="text-muted-foreground text-lg">{description}</p>
      ) : null}
    </header>
  );
}
