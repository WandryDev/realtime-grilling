import { Button, type ButtonProps } from "@/components/ui/button";
import { linkButtonProps } from "@/lib/link-button";

import { FloatingLink } from "./floating-link";

/*
 * A widget button that navigates when it gets an `href` (the app) and stays
 * a plain button without one (the static /dev previews). In Tauri it hands
 * over to the window of the route (FloatingLink).
 */
export function ActionButton({
  href,
  ...props
}: ButtonProps & { href?: string }) {
  return <Button {...linkButtonProps(href, FloatingLink)} {...props} />;
}
