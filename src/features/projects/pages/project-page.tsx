"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useCallSession } from "@/data/call-session";
import { addPerson, removeProjectPeople, usePeople } from "@/data/people";
import { deleteProject, updateProject, useProject } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { exportToMarkdown, refreshBrief } from "../api";
import { MissingEntity } from "../components/missing-entity";
import {
  AddPersonDialogLive,
  DeleteProjectDialogLive,
  EditProjectDialog,
  type NewPersonInput,
} from "../components/project-dialogs";
import type { BriefState } from "../components/project-sections";
import { MoreIcon, PencilIcon, TrashIcon } from "../icons";
import { ADD_PERSON, BRIEF_STATUS, DELETE_PROJECT } from "../mock";
import {
  defaultHowToAsk,
  LEVEL_BY_CHOICE,
  projectPageData,
} from "../project-data";
import { ProjectScreen, projectSectionId } from "../screens/project-screen";

/**
 * `?demo=` states of the project page: the brief refreshing or outdated,
 * and each dialog open.
 */
export const PROJECT_DEMO_STATES = [
  "updating",
  "outdated",
  "add-person",
  "edit",
  "delete",
] as const;

type ProjectDialog = "add-person" | "edit" | "delete";

const REFRESHED_STATUS = { ...BRIEF_STATUS, fresh: "Обновлён только что" };

/** `/project?id=`: the project page with its live dialogs. */
export function ProjectPage() {
  const id = useSearchParams().get("id");
  // A fresh page per project: brief state, anchors and dialogs reset.
  return <ProjectView id={id} key={id ?? ""} />;
}

function ProjectView({ id }: { id: string | null }) {
  const router = useRouter();
  const project = useProject(id);
  const people = usePeople(id);
  const session = useCallSession();
  const demo = useDemoState(PROJECT_DEMO_STATES);

  const [briefState, setBriefState] = useState<BriefState>("fresh");
  const [refreshed, setRefreshed] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const [anchor, setAnchor] = useState("brief");
  const [deleted, setDeleted] = useState(false);
  const cancelRefresh = useRef<(() => void) | null>(null);

  // A forced state applies when the demo param changes.
  useEffect(() => {
    if (demo === "updating" || demo === "outdated") {
      setBriefState(demo);
    } else if (demo) {
      setDialog(demo);
    }
  }, [demo]);

  // Stop a running refresh when leaving the page or switching projects.
  useEffect(
    () => () => {
      cancelRefresh.current?.();
    },
    []
  );

  const data = useMemo(() => {
    const page = projectPageData({ id: id ?? "" }, people, briefState);
    return refreshed ? { ...page, briefStatus: REFRESHED_STATUS } : page;
  }, [briefState, id, people, refreshed]);

  const handleRefresh = useCallback(() => {
    cancelRefresh.current?.();
    setBriefState("updating");
    cancelRefresh.current = refreshBrief(id ?? "", () => {
      cancelRefresh.current = null;
      setBriefState("fresh");
      setRefreshed(true);
      toast.add({ title: "Бриф обновлён", type: "success" });
    });
  }, [id]);

  const handleStopRefresh = useCallback(() => {
    cancelRefresh.current?.();
    cancelRefresh.current = null;
    setBriefState("fresh");
    toast.add({ title: "Обновление остановлено", type: "info" });
  }, []);

  const handleAnchor = useCallback((value: string) => {
    setAnchor(value);
    document
      .querySelector(`#${projectSectionId(value)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const closeDialog = useCallback((open: boolean) => {
    if (!open) {
      setDialog(null);
    }
  }, []);
  const openEdit = useCallback(() => setDialog("edit"), []);
  const openDelete = useCallback(() => setDialog("delete"), []);
  const openAddPerson = useCallback(() => setDialog("add-person"), []);

  const handleEdit = useCallback(
    (values: { description: string; name: string }) => {
      if (!project) {
        return;
      }
      updateProject(project.id, {
        description: values.description,
        initial: values.name.charAt(0).toUpperCase(),
        name: values.name,
      });
      setDialog(null);
      toast.add({ title: "Проект сохранён", type: "success" });
    },
    [project]
  );

  const handleAddPerson = useCallback(
    (input: NewPersonInput) => {
      if (!project) {
        return;
      }
      const tech = LEVEL_BY_CHOICE[input.tech] ?? 2;
      addPerson({
        howToAsk: defaultHowToAsk(tech),
        name: input.name,
        notes: input.notes || undefined,
        project: LEVEL_BY_CHOICE[input.understanding] ?? 3,
        projectId: project.id,
        role: input.role,
        tech,
      });
      setDialog(null);
      toast.add({ title: `${input.name} в проекте`, type: "success" });
    },
    [project]
  );

  const handleDelete = useCallback(
    ({ exportFirst }: { exportFirst: boolean }) => {
      if (!project) {
        return;
      }
      if (exportFirst) {
        // Fire and forget: the export toast comes on its own.
        exportToMarkdown("calls", project.name);
      }
      setDeleted(true);
      setDialog(null);
      deleteProject(project.id);
      removeProjectPeople(project.id);
      router.push(routes.home());
      toast.add({ title: `Проект ${project.name} удалён`, type: "success" });
    },
    [project, router]
  );

  const handleExportBrief = useCallback(() => {
    if (project) {
      exportToMarkdown("brief", project.name);
    }
  }, [project]);

  if (deleted) {
    return null;
  }
  if (!project) {
    return (
      <MissingEntity
        className="h-svh"
        description="Возможно, его удалили. Остальные проекты на главной."
        title="Проект не найден"
      />
    );
  }

  const callOnProject =
    session.status !== "idle" && session.projectId === project.id;

  return (
    <ProjectScreen
      anchor={anchor}
      briefState={briefState}
      className="h-svh"
      data={data}
      dialogs={
        <>
          <EditProjectDialog
            description={project.description}
            name={project.name}
            onOpenChange={closeDialog}
            onSave={handleEdit}
            open={dialog === "edit"}
          />
          <AddPersonDialogLive
            levels={ADD_PERSON}
            onAdd={handleAddPerson}
            onOpenChange={closeDialog}
            open={dialog === "add-person"}
            project={project.name}
          />
          <DeleteProjectDialogLive
            contents={data.deleteContents}
            description={DELETE_PROJECT.description}
            onDelete={handleDelete}
            onOpenChange={closeDialog}
            open={dialog === "delete"}
            project={project.name}
          />
        </>
      }
      headerActions={
        <ProjectMenu
          callOnProject={callOnProject}
          onDelete={openDelete}
          onEdit={openEdit}
          onExportBrief={handleExportBrief}
        />
      }
      onAddPerson={openAddPerson}
      onAnchorChange={handleAnchor}
      onRefreshBrief={handleRefresh}
      onStopRefresh={handleStopRefresh}
      project={project}
    />
  );
}

/** "Изменить" and the "⋯" menu: export the brief, delete the project. */
function ProjectMenu({
  callOnProject,
  onDelete,
  onEdit,
  onExportBrief,
}: {
  /** A call on this project is running: deleting waits for its end. */
  callOnProject: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onExportBrief: () => void;
}) {
  return (
    <>
      <Button className="h-9" onClick={onEdit} variant="secondary">
        <PencilIcon className="size-3.5" />
        Изменить
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Ещё"
              className="size-9"
              size="icon"
              variant="secondary"
            />
          }
        >
          <MoreIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onExportBrief}>
            Экспорт брифа
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={callOnProject}
            onClick={onDelete}
            variant="destructive"
          >
            <TrashIcon />
            {callOnProject
              ? "Удалить проект: сначала завершите звонок"
              : "Удалить проект"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
