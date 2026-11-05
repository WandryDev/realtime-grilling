"use client";

import { Fragment, type ReactNode } from "react";

import {
  ContextColumnDescription,
  ContextColumnHeader,
} from "@/components/ui/context-card";
import { NavMenu } from "@/components/ui/nav-item";
import { MainWindow } from "@/features/shell/main-window";
import { cn } from "@/lib/utils";

import { ChevronRightIcon, LockIcon } from "../icons";
import { CALL, CALL_FACTS, type CallFact } from "../mock";
import { usePostCallInfo, usePostCallLinks } from "./links";
import {
  NavBusy,
  NavDone,
  NavMeta,
  NavPending,
  PanelBackLink,
  PanelNavItem,
  PanelSidebar,
} from "./panel-nav";

/*
 * The window of one finished call: call navigation on the left, the white
 * panel, a 320px column on the right. The title bar names the project and
 * the call and says that everything stays on this computer.
 */

export type CallSection = "summary" | "tasks" | "proposals" | "transcript";

/** "Хранится только на этом компьютере" pill in the title bar. */
export function LocalOnlyBadge({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "bg-background text-muted-foreground flex h-8 items-center gap-2 rounded-full px-3 text-sm",
        className
      )}
    >
      <LockIcon className="size-3.5 shrink-0" />
      Хранится только на этом компьютере
    </p>
  );
}

export function CallSidebar({
  active,
  facts,
  pendingProposals,
  processing = false,
  taskCards = CALL.taskCards,
}: {
  active: CallSection;
  /** Details under the navigation, shown while the summary is built. */
  facts?: CallFact[];
  /** Proposals left to review; 0 shows a check. */
  pendingProposals: number;
  /** Summary is still being built: the summary spins, cards wait. */
  processing?: boolean;
  taskCards?: number;
}) {
  const links = usePostCallLinks();
  const info = usePostCallInfo();
  let proposalsMarker: ReactNode = <NavDone />;
  if (processing) {
    proposalsMarker = null;
  } else if (pendingProposals > 0) {
    proposalsMarker = <NavPending count={pendingProposals} />;
  }

  return (
    <PanelSidebar>
      {links.back ? <PanelBackLink {...links.back} /> : null}
      <NavMenu aria-label="Разделы звонка">
        <PanelNavItem
          active={active === "summary"}
          href={links.summary}
          label="Итоги"
          trailing={processing ? <NavBusy /> : null}
        />
        <PanelNavItem
          active={active === "tasks"}
          disabled={processing}
          href={links.tasks}
          label="Карточки задач"
          trailing={processing ? null : <NavMeta>{taskCards}</NavMeta>}
        />
        <PanelNavItem
          active={active === "proposals"}
          disabled={processing}
          href={links.proposals}
          label="Предложения"
          trailing={proposalsMarker}
        />
        <PanelNavItem
          active={active === "transcript"}
          href={links.transcript()}
          label="Расшифровка"
          trailing={<NavMeta>{info.duration}</NavMeta>}
        />
      </NavMenu>
      {facts ? (
        <dl className="flex flex-col gap-3.5 px-3">
          {facts.map((fact) => (
            <div className="flex flex-col gap-0.5" key={fact.label}>
              <dt className="text-muted-foreground text-sm">{fact.label}</dt>
              <dd className="text-base">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </PanelSidebar>
  );
}

export function CallWindow({
  active,
  aside,
  children,
  className,
  facts = CALL_FACTS,
  overlay,
  panelClassName,
  pendingProposals = 7,
  processing = false,
  taskCards,
}: {
  active: CallSection;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Details under the navigation while the summary is built. */
  facts?: CallFact[];
  overlay?: ReactNode;
  panelClassName?: string;
  pendingProposals?: number;
  processing?: boolean;
  taskCards?: number;
}) {
  const info = usePostCallInfo();
  return (
    <MainWindow
      actions={<LocalOnlyBadge />}
      aside={aside}
      className={className}
      overlay={overlay}
      panelClassName={panelClassName}
      sidebar={
        <CallSidebar
          active={active}
          facts={processing ? facts : undefined}
          pendingProposals={pendingProposals}
          processing={processing}
          taskCards={taskCards}
        />
      }
      subtitle={info.subtitle}
      title={info.project}
    >
      {children}
    </MainWindow>
  );
}

/** Content of the panel: 64px sides, 48 top, 56 bottom. */
export function PanelPage({
  "aria-busy": busy,
  children,
  className,
}: {
  /** The content is still being read. */
  "aria-busy"?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <main
      aria-busy={busy || undefined}
      className={cn("flex flex-col gap-7 px-16 pt-12 pb-14", className)}
    >
      {children}
    </main>
  );
}

export function CallBreadcrumb({
  className,
  items,
}: {
  className?: string;
  items: { href: string; label: string }[];
}) {
  const { Link } = usePostCallLinks();
  return (
    <nav aria-label="Путь" className={className}>
      <ol className="text-muted-foreground flex items-center gap-2 text-sm">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 ? (
              <li aria-hidden="true" className="flex">
                <ChevronRightIcon className="text-subtle size-3" />
              </li>
            ) : null}
            <li>
              <Link
                className="hover:text-foreground focus-visible:focus-ring rounded-xs"
                href={item.href}
              >
                {item.label}
              </Link>
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** 40px page title. */
export function CallTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn(
        "text-3xl font-semibold tracking-tight text-balance",
        className
      )}
    >
      {children}
    </h1>
  );
}

/** Breadcrumb, title and whatever goes under it, 16px apart. */
export function CallPageHeader({
  breadcrumb,
  children,
  className,
  title,
}: {
  breadcrumb: { href: string; label: string }[];
  children?: ReactNode;
  className?: string;
  title: ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-4", className)}>
      <CallBreadcrumb items={breadcrumb} />
      <CallTitle>{title}</CallTitle>
      {children}
    </header>
  );
}

/** The 320px column right of the panel. */
export function SideColumn({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <aside
      aria-label={label}
      className={cn(
        "flex w-80 shrink-0 flex-col gap-2.5 overflow-y-auto px-2 py-3",
        className
      )}
    >
      {children}
    </aside>
  );
}

/** White card on the gray column. */
export function SideCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-background shadow-card flex flex-col gap-3 rounded-md p-4",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * Heading of a block in the right column, 13px semibold, with a muted note
 * or a small action on the right.
 */
export function SideHeading({
  action,
  children,
  className,
  id,
  note,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  note?: ReactNode;
}) {
  return (
    <ContextColumnHeader className={className}>
      <h2 className="font-semibold" id={id}>
        {children}
      </h2>
      {note ? (
        <ContextColumnDescription>{note}</ContextColumnDescription>
      ) : null}
      {action}
    </ContextColumnHeader>
  );
}
