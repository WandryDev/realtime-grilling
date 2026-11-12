"use client";

import NextLink from "next/link";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";

import { useCallTranscript } from "@/data/call-records";
import { type CallRecord, NO_PROJECT_CALL } from "@/data/calls";
import { useProject } from "@/data/projects";
import { inTauri } from "@/effect/runtime";
import { showFloatingWindow, windowOfRoute } from "@/features/shell/api";
import { routes } from "@/lib/routes";

import {
  type PostCallInfo,
  type PostCallLinks,
  PostCallProvider,
} from "../components/links";
import { NotFoundState } from "../components/not-found-state";

/*
 * Shared frame of the app pages of a finished call: routes of that call for
 * every link of the screens, its title-bar info, and the "not found" state
 * for an unknown `?id=`.
 */

/** Window size in the app: the whole viewport. */
export const APP_WINDOW = "h-svh";

/**
 * A link of the main window. In Tauri a route of a floating window
 * ("Начать звонок" → the start widget) shows that window instead of
 * loading its page here.
 */
export function AppLink({
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const show = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented) {
        event.preventDefault();
        showFloatingWindow(href);
      }
    },
    [href, onClick]
  );
  if (!inTauri || windowOfRoute(href) === "main") {
    return <NextLink href={href} onClick={onClick} {...props} />;
  }
  return <a href={href} onClick={show} {...props} />;
}

/** Links that don't depend on a call: history, search, start a call. */
export function baseLinks(): PostCallLinks {
  return {
    allCalls: routes.history(),
    back: { href: routes.home(), label: "Главная" },
    callSummary: routes.callSummary,
    callTranscript: routes.callTranscript,
    history: routes.history(),
    Link: AppLink,
    project: routes.home(),
    projectCalls: routes.history,
    proposals: routes.home(),
    startCall: routes.startWidget(),
    summary: routes.home(),
    tasks: routes.home(),
    transcript: () => routes.home(),
  };
}

function useCallLinks(call: CallRecord, projectName: string): PostCallLinks {
  const recordings = useCallTranscript(call.id).data;
  const transcriptDeleted =
    recordings.length > 0 && recordings.every((item) => item.transcriptDeleted);
  return useMemo(() => {
    // A call without a project belongs to the whole history.
    const { projectId } = call;
    const project = projectId ? routes.project(projectId) : routes.history();
    return {
      ...baseLinks(),
      back: { href: project, label: projectName },
      history: routes.history(projectId ?? undefined),
      project,
      proposals: routes.callProposals(call.id),
      summary: routes.callSummary(call.id),
      tasks: routes.callTasks(call.id),
      transcript: (moment?: string) => routes.callTranscript(call.id, moment),
      transcriptDeleted,
    };
  }, [call, projectName, transcriptDeleted]);
}

function CallFrame({
  call,
  children,
}: {
  call: CallRecord;
  children: ReactNode;
}) {
  const project = useProject(call.projectId);
  const projectName =
    call.projectId === null ? NO_PROJECT_CALL : (project?.name ?? "Проект");
  const links = useCallLinks(call, projectName);
  const info = useMemo<PostCallInfo>(
    () => ({
      callLabel: `Звонок ${call.day}`,
      dateLabel: call.dateLabel,
      duration: call.duration,
      participants: call.participants,
      project: projectName,
      subtitle: `звонок ${call.day}`,
    }),
    [call, projectName]
  );

  return (
    <PostCallProvider info={info} links={links}>
      {children}
    </PostCallProvider>
  );
}

/** Links of the app around a call screen, or "Звонок не найден". */
export function CallPageFrame({
  call,
  children,
}: {
  call: CallRecord | undefined;
  children: ReactNode;
}) {
  const links = useMemo(baseLinks, []);
  if (!call) {
    return (
      <PostCallProvider links={links}>
        <NotFoundState
          className={APP_WINDOW}
          description="Такого звонка нет в истории на этом компьютере. Возможно, ссылка устарела или звонок удалили."
          homeHref={routes.home()}
          title="Звонок не найден"
        />
      </PostCallProvider>
    );
  }
  return <CallFrame call={call}>{children}</CallFrame>;
}
