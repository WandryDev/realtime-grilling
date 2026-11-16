import type { ComponentProps } from "react";

import { CallWidget } from "@/components/ui/call-widget";
import { cn } from "@/lib/utils";

/*
 * The 320px floating widget of the screens: CallWidget with the 20px padding
 * and 18px rhythm of the Paper desktop scenes.
 */
export function WidgetCard({ className, ...props }: ComponentProps<"div">) {
  return <CallWidget className={cn("gap-[18px] p-5", className)} {...props} />;
}
