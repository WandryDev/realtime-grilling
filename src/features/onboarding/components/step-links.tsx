import Link from "next/link";
import type { ReactNode } from "react";

import {
  OnboardingBackButton,
  OnboardingNextButton,
} from "./onboarding-actions";

/*
 * Footer navigation of a step. With `href` the button is a real link to the
 * neighbouring step; without it (static previews) it stays a plain button.
 * A disabled "Продолжить" is never a link: the step isn't done yet.
 *
 * Base UI marks a non-native Button with role="button"; clearing the role
 * lets screen readers announce a link, which is what it is.
 */
const AS_LINK = { nativeButton: false, role: undefined } as const;

export function StepBackButton({ href }: { href?: string }) {
  if (!href) {
    return <OnboardingBackButton />;
  }
  return <OnboardingBackButton {...AS_LINK} render={<Link href={href} />} />;
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
    <OnboardingNextButton {...AS_LINK} render={<Link href={href} />}>
      {children}
    </OnboardingNextButton>
  );
}
