import Link from "next/link";
import { type ComponentType, createElement } from "react";

/*
 * Turns a Base UI Button into a link when there is an href; without one
 * (the /dev previews) it stays a plain button. Base UI marks a non-native
 * Button with role="button"; clearing it lets screen readers announce the
 * link it is.
 *
 *   <Button {...linkButtonProps(routes.home())}>На главную</Button>
 *
 * `link` swaps next/link for another component that takes an href.
 */
export function linkButtonProps(
  href?: string,
  link: ComponentType<{ href: string }> = Link
) {
  return href
    ? {
        nativeButton: false,
        render: createElement(link, { href }),
        role: undefined,
      }
    : {};
}
