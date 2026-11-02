import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { ConnectedMark } from "./connected-card";
import { linkButtonProps } from "./link-button";
import type { ServiceConnection } from "./mock";

/*
 * Service row of the onboarding list (Paper "05 Интеграции"): 36px logo tile,
 * name and a line under it, and a 150px status column that doubles as the
 * action. Rows are separated by hairlines, the list is closed top and bottom.
 * - idle: gray "Подключить" pill
 * - connected: green check, "Подключено"
 * - waiting: spinner, "Ждём браузер"
 * - error: the reason in red, "Исправить" on soft red
 * With `href` the action is a link to the service step; while waiting the
 * status itself links there.
 */
export function ServiceList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col", className)} {...props} />;
}

export function ServiceRow({
  description,
  href,
  icon,
  name,
  onAction,
  status,
}: {
  description: ReactNode;
  /** The service step: "Подключить", "Исправить" and "Ждём браузер" link there. */
  href?: string;
  /** ServiceTile. */
  icon: ReactNode;
  name: string;
  /** "Подключить" or "Исправить": opens the service step. */
  onAction?: () => void;
  status: ServiceConnection;
}) {
  return (
    <Item
      className="border-t border-b-0 px-0 py-4 last:border-b"
      data-status={status}
      render={<li />}
      variant="divided"
    >
      <ItemMedia>{icon}</ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle className="font-semibold">{name}</ItemTitle>
        <ItemDescription
          className={cn(status === "error" && "text-contradiction")}
        >
          {description}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="w-[150px]">
        <ServiceRowStatus
          href={href}
          name={name}
          onAction={onAction}
          status={status}
        />
      </ItemActions>
    </Item>
  );
}

function ServiceRowStatus({
  href,
  name,
  onAction,
  status,
}: {
  href?: string;
  name: string;
  onAction?: () => void;
  status: ServiceConnection;
}) {
  switch (status) {
    case "connected":
      return <ConnectedMark />;
    case "waiting": {
      const content = (
        <>
          <Spinner
            aria-hidden="true"
            aria-label={undefined}
            className="text-foreground [&_[data-slot=spinner-track]]:stroke-border"
            role="presentation"
          />
          Ждём браузер
        </>
      );
      const className =
        "text-muted-foreground flex h-8 items-center gap-2 text-sm";
      return href ? (
        <Link
          aria-label={`${name}: ждём браузер`}
          className={cn(
            className,
            "hover:text-foreground focus-visible:focus-ring -mx-2 rounded-full px-2 transition-colors"
          )}
          href={href}
        >
          {content}
        </Link>
      ) : (
        <span className={className}>{content}</span>
      );
    }
    case "error":
      return (
        <Button
          aria-label={`Исправить ${name}`}
          className="bg-contradiction-soft text-contradiction hover:bg-contradiction-soft/70 active:bg-contradiction-soft/50 gap-1.5"
          onClick={onAction}
          {...linkButtonProps(href)}
          variant="secondary"
        >
          <span
            aria-hidden="true"
            className="bg-contradiction size-1.5 shrink-0 rounded-full"
          />
          Исправить
        </Button>
      );
    default:
      return (
        <Button
          aria-label={`Подключить ${name}`}
          onClick={onAction}
          {...linkButtonProps(href)}
          variant="secondary"
        >
          Подключить
        </Button>
      );
  }
}
