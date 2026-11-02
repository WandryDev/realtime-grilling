import { Button, type ButtonProps } from "@/components/ui/button";
import { ExternalArrowIcon } from "@/features/onboarding/components/icons";
import { cn } from "@/lib/utils";

/*
 * Footer action that opens the browser ("Открыть github.com/login/device",
 * "Продолжить в браузере"): a 40px pill with the arrow out of the window.
 * Black while it is the next step, gray to open the page again.
 */
export function BrowserButton({
  children,
  className,
  variant = "default",
  ...props
}: Omit<ButtonProps, "size" | "variant"> & {
  variant?: "default" | "secondary";
}) {
  return (
    <Button
      className={cn("pl-5", className)}
      size="lg"
      variant={variant}
      {...props}
    >
      {children}
      <ExternalArrowIcon className="size-3" />
    </Button>
  );
}
