import type { ReactNode } from "react";

import { linkButtonProps } from "@/lib/link-button";

import {
  OnboardingBackButton,
  OnboardingNextButton,
} from "./onboarding-actions";

/*
 * Footer navigation of a step. With `href` the button is a real link to the
 * neighbouring step; without it (static previews) it stays a plain button.
 * A disabled "Продолжить" is never a link: the step isn't done yet.
 */

export function StepBackButton({ href }: { href?: string }) {
  if (!href) {
    return <OnboardingBackButton />;
  }
  return <OnboardingBackButton {...linkButtonProps(href)} />;
}

export function StepNextButton({
  children,
  disabled = false,
  href,
}: {
  children?: ReactNode;
  disabled?: boolean;
  href?: string;
}) {
  if (!href || disabled) {
    return (
      <OnboardingNextButton disabled={disabled}>
        {children}
      </OnboardingNextButton>
    );
  }
  return (
    <OnboardingNextButton {...linkButtonProps(href)}>
      {children}
    </OnboardingNextButton>
  );
}
