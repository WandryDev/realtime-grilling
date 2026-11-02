"use client";

import {
  type ComponentProps,
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from "react";

import { CALL, HREF } from "../mock";

/*
 * Where the links of the after-call screens lead and what the window says
 * about the call. /dev/screens uses the defaults: anchors to the preview
 * frames and the Телемедиа call. The app wraps a page in
 * <PostCallProvider> with routes of the open call and a Next.js Link.
 */

export type LinkComponent = ComponentType<
  ComponentProps<"a"> & { href: string }
>;

export interface PostCallLinks {
  /** "Все звонки" in the history sidebar. */
  allCalls: string;
  /** Back link at the top of the sidebar, app only. */
  back?: { href: string; label: string };
  /** A history row: the summary of that call. */
  callSummary: (callId: string) => string;
  /** A search result: the transcript of that call at the found phrase. */
  callTranscript: (callId: string, moment?: string) => string;
  /** Calls of the project of the open call. */
  history: string;
  Link: LinkComponent;
  /** Page of the project of the open call. */
  project: string;
  /** A project in the history sidebar. */
  projectCalls: (projectId: string) => string;
  proposals: string;
  /** "Начать звонок". */
  startCall?: string;
  summary: string;
  tasks: string;
  /** Transcript of the open call, at a moment (question, turn or time). */
  transcript: (moment?: string) => string;
}

/** What the title bar, the breadcrumbs and the meta line say. */
export interface PostCallInfo {
  /** "Звонок 19 октября" in the breadcrumbs. */
  callLabel: string;
  dateLabel: string;
  duration: string;
  participants: string;
  project: string;
  /** "звонок 19 октября" in the title bar. */
  subtitle: string;
}

function Anchor(props: ComponentProps<"a"> & { href: string }) {
  return <a {...props} />;
}

const PREVIEW_LINKS: PostCallLinks = {
  allCalls: HREF.history,
  callSummary: () => HREF.call,
  callTranscript: () => HREF.details,
  history: HREF.history,
  Link: Anchor,
  project: HREF.project,
  projectCalls: () => HREF.project,
  proposals: HREF.proposals,
  summary: HREF.summary,
  tasks: HREF.tasks,
  transcript: () => HREF.details,
};

const PREVIEW_INFO: PostCallInfo = {
  callLabel: "Звонок 19 октября",
  dateLabel: CALL.dateLabel,
  duration: CALL.duration,
  participants: CALL.participants,
  project: CALL.project,
  subtitle: CALL.subtitle,
};

const PostCallContext = createContext<{
  info: PostCallInfo;
  links: PostCallLinks;
}>({ info: PREVIEW_INFO, links: PREVIEW_LINKS });

export function PostCallProvider({
  children,
  info = PREVIEW_INFO,
  links,
}: {
  children: ReactNode;
  info?: PostCallInfo;
  links: PostCallLinks;
}) {
  const value = useMemo(() => ({ info, links }), [info, links]);
  return (
    <PostCallContext.Provider value={value}>
      {children}
    </PostCallContext.Provider>
  );
}

export function usePostCallLinks() {
  return useContext(PostCallContext).links;
}

export function usePostCallInfo() {
  return useContext(PostCallContext).info;
}
