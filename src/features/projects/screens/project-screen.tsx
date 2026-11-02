import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { MainSidebar } from "@/features/shell/app-sidebar";
import {
  MainWindow,
  PageContent,
  TitlebarSearch,
} from "@/features/shell/main-window";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import {
  AddPersonDialog,
  DeleteProjectDialog,
  DialogScrim,
} from "../components/project-dialogs";
import {
  ProjectHeader,
  ProposalsBanner,
  SourcesStatus,
} from "../components/project-header";
import {
  BriefSection,
  type BriefState,
  CallsSection,
  PeopleSection,
  ProjectAnchors,
  SourcesSection,
} from "../components/project-sections";
import { ADD_PERSON, DELETE_PROJECT, PROJECT, type PROPOSALS } from "../mock";
import { demoProjectPageData, type ProjectPageData } from "../project-data";

export type ProjectSectionId = "brief" | "people" | "calls" | "sources";

const ALL_SECTIONS: ProjectSectionId[] = [
  "brief",
  "people",
  "calls",
  "sources",
];

/** Element id of a section, the target of its anchor. */
export function projectSectionId(section: string) {
  return `project-${section}`;
}

/*
 * 10–12 Проект: one long page with anchors. `briefState`:
 * - fresh: the brief before a call, "Обновить" in gray
 * - updating: the agent rereads what changed, the old brief is dimmed
 * - outdated: older than a week, "Обновить бриф" turns black, a source error
 *   shows in the header
 * 15, 22: `dialog` draws "Новый человек" or the delete confirmation over the
 * page. `sections` picks what is on screen under it.
 *
 * Without `project` and `data` it is the demo project from Paper. The app
 * passes the stored project, its data, the live header actions and dialogs
 * (`headerActions`, `dialogs`) and the handlers.
 */
export function ProjectScreen({
  anchor,
  briefState = "fresh",
  className,
  data,
  dialog,
  dialogs,
  headerActions,
  onAddPerson,
  onAnchorChange,
  onRefreshBrief,
  onStopRefresh,
  project = PROJECT,
  proposals,
  sections = ALL_SECTIONS,
}: {
  /** Active anchor; with `onAnchorChange` the anchors scroll the page. */
  anchor?: string;
  briefState?: BriefState;
  className?: string;
  data?: ProjectPageData;
  /** Static dialog drawn over the page (preview). */
  dialog?: "add-person" | "delete-project";
  /** Live dialogs of the app; they portal over the window. */
  dialogs?: ReactNode;
  headerActions?: ReactNode;
  onAddPerson?: () => void;
  onAnchorChange?: (anchor: string) => void;
  onRefreshBrief?: () => void;
  onStopRefresh?: () => void;
  project?: { description: string; id: string; name: string };
  /** Unreviewed suggestions after a call; null hides the banner. */
  proposals?: typeof PROPOSALS | null;
  sections?: ProjectSectionId[];
}) {
  const page = data ?? demoProjectPageData(briefState);
  const shownProposals = proposals === undefined ? page.proposals : proposals;

  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      overlay={<ProjectDialog dialog={dialog} project={project.name} />}
      sidebar={<MainSidebar active={project.id} />}
      title={project.name}
    >
      <PageContent
        aria-hidden={dialog ? true : undefined}
        className="gap-7 pt-9 pb-14"
        inert={dialog ? true : undefined}
      >
        <ProjectHeader
          actions={headerActions}
          description={project.description}
          name={project.name}
        />
        <SourcesStatus sources={page.sourcesStatus} synced={page.synced} />
        {shownProposals ? (
          <ProposalsBanner
            action={
              <Button
                className="h-9 px-4"
                {...linkButtonProps(
                  routes.callProposals(shownProposals.callId)
                )}
              >
                Разобрать
              </Button>
            }
            detail={shownProposals.detail}
            title={shownProposals.title}
          />
        ) : null}
        <ProjectAnchors
          anchors={page.anchors}
          className="bg-background sticky top-0 z-10"
          onValueChange={onAnchorChange}
          value={anchor}
        />
        {sections.includes("brief") ? (
          <BriefSection
            brief={page.brief}
            id={projectSectionId("brief")}
            onRefresh={onRefreshBrief}
            onStop={onStopRefresh}
            state={briefState}
            status={page.briefStatus}
          />
        ) : null}
        {sections.includes("people") ? (
          <PeopleSection
            id={projectSectionId("people")}
            onAdd={onAddPerson}
            people={page.people}
            projectId={project.id}
          />
        ) : null}
        {sections.includes("calls") ? (
          <CallsSection
            calls={page.calls}
            hidden={page.callsSummary.hidden}
            id={projectSectionId("calls")}
            moreHref={routes.history(project.id)}
            summary={page.callsSummary.summary}
          />
        ) : null}
        {sections.includes("sources") ? (
          <SourcesSection
            id={projectSectionId("sources")}
            sources={page.sources}
          />
        ) : null}
      </PageContent>
      {dialogs}
    </MainWindow>
  );
}

function ProjectDialog({
  dialog,
  project,
}: {
  dialog?: "add-person" | "delete-project";
  project: string;
}) {
  if (dialog === "add-person") {
    return (
      <DialogScrim>
        <AddPersonDialog person={ADD_PERSON} project={project} />
      </DialogScrim>
    );
  }
  if (dialog === "delete-project") {
    return (
      <DialogScrim>
        <DeleteProjectDialog
          contents={DELETE_PROJECT.contents}
          description={DELETE_PROJECT.description}
          project={project}
        />
      </DialogScrim>
    );
  }
  return null;
}
