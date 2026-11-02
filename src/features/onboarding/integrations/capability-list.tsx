import { CheckIcon, CrossIcon } from "@/features/onboarding/components/icons";
import { cn } from "@/lib/utils";

/*
 * "Что сможет Grill": what the integration may do (green check) and what it
 * never does (gray cross, muted text), under a hairline.
 */
export function CapabilityList({
  className,
  items,
  title = "Что сможет Grill",
}: {
  className?: string;
  items: { allowed: boolean; label: string }[];
  title?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "border-border flex flex-col gap-0.5 border-t pt-1",
        className
      )}
    >
      <h2 className="text-muted-foreground pt-3.5 pb-1.5 text-sm font-medium">
        {title}
      </h2>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li className="flex items-center gap-3 py-1.5" key={item.label}>
            <span className="flex size-5 shrink-0 items-center justify-center">
              {item.allowed ? (
                <CheckIcon className="text-confirmed size-3.5" />
              ) : (
                <CrossIcon className="text-subtle size-3.5" strokeWidth={1.5} />
              )}
            </span>
            <span
              className={cn(
                "text-base",
                item.allowed ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
