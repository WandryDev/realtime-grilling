import type { ReactNode } from "react";

import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";
import { MicSmallIcon, SpeechBarsIcon } from "./icons";
import type { SetupSummaryIcon, SetupSummaryItem } from "./mock";
import { ServiceLogo } from "./service-logo";

/*
 * Paper "06 Готово": a white card with what was set up. Each row is the
 * step's 14px mark, the step and its result on the right. Groups (required
 * steps, integrations) are split by a hairline. A skipped integration is
 * gray and offers "Подключить" in place of the result.
 */
export function SetupSummary({
  className,
  connectHref,
  groups,
  onConnect,
}: {
  className?: string;
  /** Where "Подключить" of a skipped integration leads (a link). */
  connectHref?: (item: SetupSummaryItem) => string | undefined;
  groups: SetupSummaryItem[][];
  /** "Подключить" of a skipped integration (a button). */
  onConnect?: (item: SetupSummaryItem) => void;
}) {
  return (
    <section
      aria-label="Итог настройки"
      className={cn(
        "bg-background shadow-card flex flex-col rounded-md px-4.5 py-2",
        className
      )}
    >
      {groups.map((group, index) => (
        <SummaryGroup
          connectHref={connectHref}
          items={group}
          // biome-ignore lint/suspicious/noArrayIndexKey: groups are static and never reorder
          key={index}
          onConnect={onConnect}
          separated={index > 0}
        />
      ))}
    </section>
  );
}

function SummaryGroup({
  connectHref,
  items,
  onConnect,
  separated,
}: {
  connectHref?: (item: SetupSummaryItem) => string | undefined;
  items: SetupSummaryItem[];
  onConnect?: (item: SetupSummaryItem) => void;
  separated: boolean;
}) {
  return (
    <>
      {separated ? <Separator className="my-1.5" /> : null}
      <ul className="flex flex-col">
        {items.map((item) => (
          <SummaryRow
            connectHref={connectHref?.(item)}
            item={item}
            key={item.label}
            onConnect={onConnect ? () => onConnect(item) : undefined}
          />
        ))}
      </ul>
    </>
  );
}

function SummaryRow({
  connectHref,
  item,
  onConnect,
}: {
  connectHref?: string;
  item: SetupSummaryItem;
  onConnect?: () => void;
}) {
  const connectable = item.skipped && !item.soon;
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <SummaryMark icon={item.icon} />
        <span
          className={cn(
            "truncate text-base",
            item.skipped ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {item.label}
        </span>
      </span>
      {connectable ? null : (
        <span
          className={cn(
            "text-muted-foreground shrink-0",
            item.valueMono ? "font-mono text-xs" : "text-sm"
          )}
        >
          {item.value}
        </span>
      )}
      {connectable ? (
        <Button
          aria-label={`Подключить ${item.label}`}
          className="-my-1"
          onClick={onConnect}
          {...linkButtonProps(connectHref)}
          size="sm"
          variant="secondary"
        >
          Подключить
        </Button>
      ) : null}
    </li>
  );
}

const MARKS: Record<SetupSummaryIcon, () => ReactNode> = {
  claude: () => <ClaudeIcon className="size-3.5" />,
  clickup: () => <ServiceLogo className="size-3.5" service="clickup" />,
  github: () => <ServiceLogo className="size-3.5" service="github" />,
  microphone: () => <MicSmallIcon className="size-3.5" />,
  outline: () => <ServiceLogo className="size-3.5" service="outline" />,
  speech: () => <SpeechBarsIcon className="size-3.5" />,
};

function SummaryMark({ icon }: { icon: SetupSummaryIcon }) {
  return (
    <span aria-hidden="true" className="flex shrink-0">
      {MARKS[icon]()}
    </span>
  );
}
