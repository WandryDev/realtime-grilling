import { Badge } from "@grill/ui/badge";
import { Button } from "@grill/ui/button";
import { Spinner } from "@grill/ui/spinner";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

import { SmallCheckIcon } from "../icons";

/*
 * Rows of Settings → Интеграции. Richer than the onboarding IntegrationRow:
 * a 36px logo tile, name and description, the status right, and an optional
 * second line (repositories, the broken key's details) with text actions in
 * a 240px column. No lines: rows sit 28px apart, groups further (the caller).
 * On a narrow panel the status drops its 180px column, and the actions wrap
 * under the details when both don't fit.
 */

/** Titled list of services: muted 13px title like SettingsSection, a muted count right. */
export function ServiceGroup({
  children,
  className,
  meta,
  title,
}: {
  children: ReactNode;
  className?: string;
  meta?: ReactNode;
  title: string;
}) {
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-4 pb-4">
        <h2 className="text-muted-foreground text-sm font-medium">{title}</h2>
        {meta ? <p className="text-muted-foreground text-sm">{meta}</p> : null}
      </div>
      <div className="flex flex-col gap-7">{children}</div>
    </section>
  );
}

export function ServiceRow({
  actions,
  className,
  description,
  details,
  error = false,
  icon,
  meta,
  name,
  status,
}: {
  /** Text buttons and the main action of the second line. */
  actions?: ReactNode;
  className?: string;
  description: ReactNode;
  /** Left part of the second line. */
  details?: ReactNode;
  /** The description is the error reason, in red. */
  error?: boolean;
  /** Brand mark, 18px in the tile. */
  icon: ReactNode;
  /** Small mono note after the name (version). */
  meta?: ReactNode;
  name: string;
  /** Right side of the first line. */
  status?: ReactNode;
}) {
  const hasSecondLine = Boolean(details || actions);
  return (
    <article aria-label={name} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-3.5">
        <span className="bg-surface flex size-9 shrink-0 items-center justify-center rounded-xs [&_svg]:size-[18px]">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{name}</h3>
            {meta ? (
              <span className="text-muted-foreground font-mono text-xs">
                {meta}
              </span>
            ) : null}
          </div>
          <p
            className={cn(
              "text-sm",
              error ? "text-contradiction" : "text-muted-foreground"
            )}
          >
            {description}
          </p>
        </div>
        {status ? (
          <div className="flex shrink-0 items-center justify-end @2xl/panel:min-w-45">
            {status}
          </div>
        ) : null}
      </div>
      {hasSecondLine ? (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pl-[50px]">
          <div className="min-w-0 flex-[1_1_14rem]">{details}</div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-5 @2xl/panel:w-60">
            {actions}
          </div>
        </div>
      ) : null}
    </article>
  );
}

/** Green check and "Подключено". */
export function ServiceConnected() {
  return (
    <p className="text-confirmed flex h-8 items-center gap-1.5 text-sm font-medium">
      <SmallCheckIcon className="size-3.5 shrink-0" />
      Подключено
    </p>
  );
}

/** Red pill "Не работает". */
export function ServiceBroken() {
  return (
    <Badge className="text-xs font-medium" size="sm" variant="contradiction">
      Не работает
    </Badge>
  );
}

/** Muted "Не подключено" and the gray "Подключить" pill. */
export function ServiceDisconnected({
  className,
  onConnect,
}: {
  className?: string;
  onConnect?: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-4", className)}>
      <p className="text-muted-foreground text-sm">Не подключено</p>
      <Button onClick={onConnect} variant="secondary">
        Подключить
      </Button>
    </div>
  );
}

/** Spinner and "Подключаем…" while the service is being connected. */
export function ServiceConnecting() {
  return (
    <p
      aria-live="polite"
      className="text-muted-foreground flex h-8 items-center gap-1.5 text-sm"
    >
      <Spinner aria-hidden="true" className="size-3.5" />
      Подключаем…
    </p>
  );
}

/** Text action of the second line: muted, ink for the main one. */
export function ServiceTextAction({
  className,
  emphasis = false,
  ...props
}: ComponentProps<typeof Button> & { emphasis?: boolean }) {
  return (
    <Button
      className={cn(
        "-mx-2 -my-[5px] px-2",
        emphasis && "text-foreground",
        className
      )}
      size="sm"
      variant="ghost"
      {...props}
    />
  );
}

/** Gray 26px chip: a repository in mono, or a tag with an icon. */
export function ServiceChip({
  className,
  ...props
}: ComponentProps<typeof Badge>) {
  return (
    <Badge
      className={cn(
        "text-foreground [&>svg]:text-muted-foreground text-xs",
        className
      )}
      variant="neutral"
      {...props}
    />
  );
}
