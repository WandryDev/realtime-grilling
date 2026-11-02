"use client";

import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { usePostCallLinks } from "./links";

/** A link that looks like a Button: navigation keeps the link role. */
export function LinkButton({
  className,
  href,
  size,
  variant,
  ...props
}: ComponentProps<"a"> & { href: string } & VariantProps<
    typeof buttonVariants
  >) {
  const { Link } = usePostCallLinks();
  return (
    <Link
      className={cn(buttonVariants({ size, variant }), className)}
      href={href}
      {...props}
    />
  );
}
