"use client";

import { ClaudeIcon } from "@grill/ui/brand-icons";
import {
  NavItem,
  NavItemLabel,
  type NavItemProps,
  NavMenu,
} from "@grill/ui/nav-item";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { AgentState } from "@/bindings";
import { useProjects } from "@/data/projects";
import type { MockProject } from "@/features/mock/projects";
import { useAgentState } from "@/features/settings/agent-status";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { HistoryIcon, HomeIcon, PlusIcon, SettingsIcon } from "./icons";

/*
 * Sidebar of the main window, on the surface gray left of the white panel.
 * 240 wide: navigation on top, settings and the agent status at
 * the bottom. The parts compose into the sidebars of the different sections
 * (MainSidebar for home and projects, settings and history build their own).
 */

export function AppSidebar({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      className={cn(
        "flex w-60 shrink-0 flex-col justify-between gap-6 overflow-y-auto px-2 pt-1 pb-2",
        className
      )}
      {...props}
    />
  );
}

/**
 * Nav item with the screens' 12px inset. With an `href` it is a Next.js
 * link, so navigation stays client-side.
 */
export function SidebarItem({
  className,
  href,
  render,
  ...props
}: NavItemProps) {
  return (
    <NavItem
      className={cn("px-3", className)}
      render={render ?? (href ? <Link href={href} /> : undefined)}
      {...props}
    />
  );
}

export function SidebarGroup({
  action,
  children,
  className,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <div className="flex h-7 shrink-0 items-center justify-between px-3">
        <p className="text-muted-foreground text-xs font-medium">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

const groupActionClassName =
  "text-muted-foreground hover:bg-border hover:text-foreground focus-visible:focus-ring -my-[7px] -mr-[7px] flex size-7 shrink-0 items-center justify-center rounded-full transition-colors";

/** Round 28px "+" next to a group title. A link when `href` is set. */
export function SidebarGroupAction({
  className,
  href,
  label,
  ...props
}: ComponentProps<"button"> & { href?: string; label: string }) {
  if (href) {
    return (
      <Link
        aria-label={label}
        className={cn(groupActionClassName, className)}
        href={href}
      >
        {props.children}
      </Link>
    );
  }
  return (
    <button
      aria-label={label}
      className={cn(groupActionClassName, className)}
      type="button"
      {...props}
    />
  );
}

/** Letter tile of a project: 20px white square with the first letter. */
export function ProjectTile({
  className,
  initial,
}: {
  className?: string;
  initial: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-background text-foreground flex size-5 shrink-0 items-center justify-center rounded-xs text-xs font-semibold",
        className
      )}
    >
      {initial}
    </span>
  );
}

export function ProjectNavItem({
  active,
  count,
  initial,
  name,
  ...props
}: NavItemProps & { count?: number; initial: string; name: string }) {
  return (
    <SidebarItem active={active} className="text-foreground" {...props}>
      <ProjectTile initial={initial} />
      <NavItemLabel>{name}</NavItemLabel>
      {count ? (
        <span className="text-muted-foreground font-mono text-xs">{count}</span>
      ) : null}
    </SidebarItem>
  );
}

type StatusTone = "ready" | "idle" | "recording" | "attention" | "error";

const STATUS_DOT: Record<StatusTone, string> = {
  attention: "bg-accent",
  error: "bg-destructive",
  idle: "bg-border-strong",
  ready: "bg-confirmed",
  recording: "bg-recording",
};

export function SidebarStatus({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "border-border flex flex-col gap-2.5 border-t p-3",
        className
      )}
      {...props}
    />
  );
}

export function SidebarStatusItem({
  description,
  href,
  icon,
  title,
  tone,
}: {
  description: string;
  /** Makes the row a link, e.g. to the settings of what it reports. */
  href?: string;
  icon: ReactNode;
  title: string;
  tone: StatusTone;
}) {
  const content = (
    <>
      <span className="bg-background text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-xs [&_svg]:size-3.5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[tone])}
      />
    </>
  );
  if (href) {
    return (
      <Link
        className="hover:bg-background/60 focus-visible:focus-ring -m-1.5 flex items-center gap-2.5 rounded-xs p-1.5 transition-colors"
        href={href}
      >
        {content}
      </Link>
    );
  }
  return <div className="flex items-center gap-2.5">{content}</div>;
}

const AGENT_STATUS: Record<
  AgentState["status"],
  { description: string; tone: StatusTone }
> = {
  error: { description: "не отвечает", tone: "error" },
  needsLogin: { description: "нужен вход", tone: "attention" },
  notInstalled: { description: "не установлен", tone: "error" },
  ready: { description: "готов к звонку", tone: "ready" },
};

/**
 * Claude Code as Settings → Агент sees it (`agent_status`); the row opens
 * that section.
 */
export function AgentSidebarStatusItem() {
  const agent = useAgentState();
  const { description, tone } = agent
    ? AGENT_STATUS[agent.status]
    : { description: "проверяю…", tone: "idle" as const };
  return (
    <SidebarStatusItem
      description={description}
      href={routes.settings("agent")}
      icon={<ClaudeIcon />}
      title="Claude Code"
      tone={tone}
    />
  );
}

/** The agent's status, the default state between calls. */
export function DefaultSidebarStatus() {
  return (
    <SidebarStatus>
      <AgentSidebarStatusItem />
    </SidebarStatus>
  );
}

type MainSection = "home" | "history" | "settings";

/**
 * Sidebar of home, project and person screens. `active` is a section or a
 * project id.
 */
export function MainSidebar({
  active,
  projects: projectsOverride,
  projectsEnd,
  status = <DefaultSidebarStatus />,
}: {
  active?: MainSection | string;
  /**
   * Projects in the list, the user's projects by default. An empty list
   * shows "Пока ни одного проекта".
   */
  projects?: MockProject[];
  /** Items after the projects, e.g. the draft project of the wizard. */
  projectsEnd?: ReactNode;
  status?: ReactNode;
}) {
  const storedProjects = useProjects();
  const projects = projectsOverride ?? storedProjects;

  return (
    <AppSidebar>
      <div className="flex flex-col gap-5">
        <NavMenu aria-label="Разделы">
          <SidebarItem active={active === "home"} href={routes.home()}>
            <HomeIcon />
            <NavItemLabel>Главная</NavItemLabel>
          </SidebarItem>
          <SidebarItem active={active === "history"} href={routes.history()}>
            <HistoryIcon />
            <NavItemLabel>История звонков</NavItemLabel>
          </SidebarItem>
        </NavMenu>
        <SidebarGroup
          action={
            <SidebarGroupAction href={routes.newProject()} label="Новый проект">
              <PlusIcon className="size-3.5" />
            </SidebarGroupAction>
          }
          title="Проекты"
        >
          {projects.length > 0 || projectsEnd ? (
            <NavMenu aria-label="Проекты">
              {projects.map((project) => (
                <ProjectNavItem
                  active={active === project.id}
                  count={project.openQuestions}
                  href={routes.project(project.id)}
                  initial={project.initial}
                  key={project.id}
                  name={project.name}
                />
              ))}
              {projectsEnd}
            </NavMenu>
          ) : (
            <p className="text-muted-foreground px-3 py-1 text-sm">
              Пока ни одного проекта
            </p>
          )}
        </SidebarGroup>
      </div>
      <div className="flex flex-col gap-3">
        <SidebarItem active={active === "settings"} href={routes.settings()}>
          <SettingsIcon />
          <NavItemLabel>Настройки</NavItemLabel>
        </SidebarItem>
        {status}
      </div>
    </AppSidebar>
  );
}
