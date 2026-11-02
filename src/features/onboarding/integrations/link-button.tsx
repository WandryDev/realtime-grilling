import Link from "next/link";

/*
 * Turns a Button into a link when the app passes an href; the /dev previews
 * pass nothing and keep a plain button. Base UI marks a non-native Button
 * with role="button"; clearing it lets screen readers announce a link.
 *
 *   <OnboardingBackButton {...linkButtonProps(backHref)} />
 */
export function linkButtonProps(href?: string) {
  return href
    ? {
        nativeButton: false,
        render: <Link href={href} />,
        role: undefined,
      }
    : {};
}
