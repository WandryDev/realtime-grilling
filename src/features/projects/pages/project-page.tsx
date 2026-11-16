"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

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
import {
  addPerson,
  removePerson,
  removeProjectPeople,
  updatePerson,
  usePeople,
} from "@/data/people";
import { deleteProject, updateProject, useProject } from "@/data/projects";
import { removeProjectSource, useProjectSources } from "@/data/sources";
import { ConnectorSources } from "@/features/connectors/connector-sources-live";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import {
  documentDropSupported,
  exportToMarkdown,
  pickDocuments,
  startBriefBuild,
  stopBriefBuild,
  useAddDocuments,
  useBriefBuild,
  useBriefProgress,
  useDocumentDrop,
} from "../api";
import { BRIEF_BUILD_STAGES } from "../backend";
import { useProjectCallLines } from "../call-lines";
import {
  DocumentsBlock,
  SoonIntegrations,
} from "../components/documents-block";
import { MissingEntity } from "../components/missing-entity";
import {
  DeleteProjectDialogLive,
  EditProjectDialog,
  PersonDialog,
  type PersonFormValues,
  RemovePersonDialog,
} from "../components/project-dialogs";
import type { BriefState } from "../components/project-sections";
import { MoreIcon, PencilIcon, TrashIcon } from "../icons";
import { DELETE_PROJECT } from "../mock";
import {
  PROJECT_LEVEL_LABELS,
  pageBriefState,
  personFormValues,
  personFromForm,
  projectPageData,
  TECH_LEVEL_LABELS,
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

const PERSON_LEVELS = {
  project: PROJECT_LEVEL_LABELS,
  tech: TECH_LEVEL_LABELS,
};

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
  const documents = useProjectSources(id);
  const calls = useProjectCallLines(id);
  const build = useBriefBuild(id);
  const progress = useBriefProgress(id);
  const session = useCallSession();
  const demo = useDemoState(PROJECT_DEMO_STATES);

  const [forcedState, setForcedState] = useState<BriefState | null>(null);
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const [editingPerson, setEditingPerson] = useState<string | null>(null);
  const [removingPerson, setRemovingPerson] = useState<string | null>(null);
  const [anchor, setAnchor] = useState("brief");
  const [deleted, setDeleted] = useState(false);
  const documentsApi = useAddDocuments(id);

  // A forced state applies when the demo param changes.
  useEffect(() => {
    if (demo === "updating" || demo === "outdated") {
      setForcedState(demo);
    } else if (demo) {
      setDialog(demo);
    }
  }, [demo]);

  const building = build?.status === "building";
  const briefState: BriefState =
    forcedState ?? (project ? pageBriefState(project, building) : "none");
  let buildStage = 0;
  if (building) {
    buildStage = build.stage;
  } else if (progress?.running) {
    buildStage = progress.finished;
  }

  const data = useMemo(
    () =>
      projectPageData(project ?? { id: id ?? "" }, people, briefState, {
        buildStage,
        calls,
        documents,
        stages: BRIEF_BUILD_STAGES,
      }),
    [briefState, buildStage, calls, documents, id, people, project]
  );

  /* -------------------------------------------------- Brief */

  const handleBuild = useCallback(() => {
    if (!project) {
      return;
    }
    setForcedState(null);
    startBriefBuild(project.id, project.name, { background: true });
  }, [project]);

  const handleStopBuild = useCallback(() => {
    setForcedState(null);
    if (id) {
      stopBriefBuild(id);
    }
    toast.add({
      description: "Бриф остался прежним",
      title: "Сборка брифа остановлена",
      type: "info",
    });
  }, [id]);

  const handleExportBrief = useCallback(() => {
    if (project) {
      exportToMarkdown("brief", project);
    }
  }, [project]);

  /* -------------------------------------------------- Documents */

  const { add: addDocuments } = documentsApi;
  const handlePick = useCallback(async () => {
    await addDocuments(await pickDocuments());
  }, [addDocuments]);
  const handleDrop = useCallback(
    (paths: string[]) => {
      addDocuments(paths);
    },
    [addDocuments]
  );
  const dropActive = useDocumentDrop(project ? handleDrop : null);
  const handleRemoveDocument = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const sourceId = event.currentTarget.dataset.id;
      if (sourceId) {
        removeProjectSource(sourceId);
      }
    },
    []
  );

  /* -------------------------------------------------- Notes */

  const handleSaveNotes = useCallback(
    (notes: string) => {
      if (!project) {
        return;
      }
      updateProject(project.id, { notes }).then((saved) => {
        if (saved) {
          toast.add({ title: "Заметки сохранены", type: "success" });
        }
      });
    },
    [project]
  );

  /* -------------------------------------------------- Dialogs */

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
  const closePersonDialog = useCallback((open: boolean) => {
    if (!open) {
      setEditingPerson(null);
    }
  }, []);
  const closeRemoveDialog = useCallback((open: boolean) => {
    if (!open) {
      setRemovingPerson(null);
    }
  }, []);

  const handleEdit = useCallback(
    (values: { description: string; name: string }) => {
      if (!project) {
        return;
      }
      setDialog(null);
      // A failed save shows its own toast.
      updateProject(project.id, {
        description: values.description,
        initial: values.name.charAt(0).toUpperCase(),
        name: values.name,
      }).then((saved) => {
        if (saved) {
          toast.add({ title: "Проект сохранён", type: "success" });
        }
      });
    },
    [project]
  );

  const handleAddPerson = useCallback(
    (values: PersonFormValues) => {
      if (!project) {
        return;
      }
      setDialog(null);
      addPerson({ ...personFromForm(values), projectId: project.id }).then(
        (personId) => {
          if (personId) {
            toast.add({ title: `${values.name} в проекте`, type: "success" });
          }
        }
      );
    },
    [project]
  );

  const editedPerson = people.find((person) => person.id === editingPerson);
  const removedPerson = people.find((person) => person.id === removingPerson);

  const handleSavePerson = useCallback(
    (values: PersonFormValues) => {
      setEditingPerson(null);
      if (!editedPerson) {
        return;
      }
      updatePerson(
        editedPerson.projectId,
        editedPerson.id,
        personFromForm(values, editedPerson)
      ).then((saved) => {
        if (saved) {
          toast.add({ title: "Профиль сохранён", type: "success" });
        }
      });
    },
    [editedPerson]
  );

  const handleRemovePerson = useCallback(() => {
    setRemovingPerson(null);
    if (!removedPerson) {
      return;
    }
    removePerson(removedPerson.id).then((removed) => {
      if (removed) {
        toast.add({
          title: `${removedPerson.name} больше не в проекте`,
          type: "success",
        });
      }
    });
  }, [removedPerson]);

  const handleDelete = useCallback(
    ({ exportFirst }: { exportFirst: boolean }) => {
      if (!project) {
        return;
      }
      if (exportFirst) {
        // The calls' export comes later: a note says so.
        exportToMarkdown("calls", project);
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
          <PersonDialog
            levels={PERSON_LEVELS}
            onOpenChange={closeDialog}
            onSave={handleAddPerson}
            open={dialog === "add-person"}
            project={project.name}
          />
          <PersonDialog
            key={editingPerson ?? ""}
            levels={PERSON_LEVELS}
            onOpenChange={closePersonDialog}
            onSave={handleSavePerson}
            open={editedPerson !== undefined}
            person={editedPerson ? personFormValues(editedPerson) : undefined}
            project={project.name}
          />
          <RemovePersonDialog
            name={removedPerson?.name ?? ""}
            onOpenChange={closeRemoveDialog}
            onRemove={handleRemovePerson}
            open={removedPerson !== undefined}
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
      documents={
        <DocumentsBlock
          adding={documentsApi.adding}
          documents={documents}
          dropActive={dropActive}
          dropSupported={documentDropSupported}
          onPick={handlePick}
          onRemove={handleRemoveDocument}
          rejected={documentsApi.rejected}
        />
      }
      headerActions={
        <ProjectMenu
          callOnProject={callOnProject}
          canExport={project.brief !== null || data.demo}
          onDelete={openDelete}
          onEdit={openEdit}
          onExportBrief={handleExportBrief}
        />
      }
      integrations={
        data.demo ? null : (
          <div className="flex flex-col gap-4">
            <ConnectorSources kind="outline" projectId={project.id} />
            <ConnectorSources kind="clickup" projectId={project.id} />
            <SoonIntegrations />
          </div>
        )
      }
      notes={project.notes}
      onAddPerson={openAddPerson}
      onAnchorChange={handleAnchor}
      onEditPerson={setEditingPerson}
      onRefreshBrief={handleBuild}
      onRemovePerson={setRemovingPerson}
      onSaveNotes={handleSaveNotes}
      onStopRefresh={handleStopBuild}
      project={project}
    />
  );
}

/** "Изменить" and the "⋯" menu: export the brief, delete the project. */
function ProjectMenu({
  callOnProject,
  canExport,
  onDelete,
  onEdit,
  onExportBrief,
}: {
  /** A call on this project is running: deleting waits for its end. */
  callOnProject: boolean;
  /** There is a brief to export. */
  canExport: boolean;
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
          <DropdownMenuItem disabled={!canExport} onClick={onExportBrief}>
            {canExport ? "Экспорт брифа" : "Экспорт брифа: сначала соберите"}
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
