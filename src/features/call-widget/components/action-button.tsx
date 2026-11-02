import Link from "next/link";

import { Button, type ButtonProps } from "@/components/ui/button";

/*
 * A widget button that navigates when it gets an `href` (the app) and stays
 * a plain button without one (the static /dev previews).
 */
export function ActionButton({
  href,
  ...props
}: ButtonProps & { href?: string }) {
  if (href) {
    return (
      <Button nativeButton={false} render={<Link href={href} />} {...props} />
    );
  }
  return <Button {...props} />;
}
