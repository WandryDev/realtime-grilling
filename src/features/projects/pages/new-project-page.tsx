"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectSource } from "@/bindings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/toast";
import { addPerson, initialsOf, usePeople } from "@/data/people";
import {
  createProject,
  deleteProject,
  updateProject,
  useProject,
  useProjects,
} from "@/data/projects";
import { removeProjectSource, useProjectSources } from "@/data/sources";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import {
  documentDropSupported,
  pickDocuments,
  sendBriefBuildToBackground,
  startBriefBuild,
  stopBriefBuild,
  useAddDocuments,
  useBriefBuild,
  useDocumentDrop,
} from "../api";
import { BRIEF_BUILD_STAGES } from "../backend";
import {
  DocumentsBlock,
  SoonIntegrations,
} from "../components/documents-block";
import {
  DraftProjectNavItem,
  WizardButton,
  WizardFooter,
  WizardTextAction,
} from "../components/wizard-layout";
import type { QuickPerson } from "../components/wizard-people";
import { type BRIEF_READY, type BRIEF_TASKS, QUICK_TECH_LEVELS } from "../mock";
import {
  DEMO_PROJECT_ID,
  defaultHowToAsk,
  LEVEL_BY_CHOICE,
  peopleCount,
} from "../project-data";
import {
  BuildingStep,
  NewProjectScreen,
  type NewProjectState,
  NotesStep,
  PeopleStep,
  ProjectStep,
  ReadyStep,
  SourcesStep,
  type WizardPerson,
} from "../screens/new-project-screen";

/** `?demo=` states of the wizard: each step, the error, the build. */
export const NEW_PROJECT_DEMO_STATES = [
  "name-error",
  "sources",
  "people",
  "notes",
  "building",
  "ready",
] as const;

type FormStep = "name" | "sources" | "people" | "notes";
type Step = FormStep | "building" | "ready";

const PREVIOUS: Record<FormStep, FormStep | null> = {
  name: null,
  notes: "people",
  people: "sources",
  sources: "name",
};

/** Step of the rail (`data-step`) → wizard step it leads back to. */
const RAIL_STEP: Record<string, FormStep> = {
  notes: "notes",
  people: "people",
  project: "name",
  sources: "sources",
};

/** The quick tech level nobody picked: the profile says "не указано". */
const LEVEL_UNSET = "unset";

const WIZARD_TECH_LEVELS = [
  { label: "не указано", value: LEVEL_UNSET },
  ...QUICK_TECH_LEVELS,
];

const TECH_TAG: Record<string, string> = {
  medium: "средне",
  none: "не технарь",
  tech: "технарь",
  [LEVEL_UNSET]: "уровень не указан",
};

/** 1 документ, 2 документа, 5 документов. */
function documentsLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} документ`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} документа`;
  }
  return `${count} документов`;
}

/** The real stages of the build (BriefProgress, design.md decision 6). */
function buildTasks(people: number, documents: number): typeof BRIEF_TASKS {
  const read = documents > 0 ? `, ${documentsLabel(documents)}` : "";
  return [
    {
      detail: `Описание, заметки, ${peopleCount(people)}${read}`,
      state: "pending",
      title: "Читаю материалы проекта",
    },
    { detail: "Claude Code", state: "pending", title: "Запускаю агента" },
    {
      detail: "Продукт, люди, сроки, термины клиента",
      state: "pending",
      title: "Агент читает материалы",
    },
    {
      detail: "Продукт, модули, стек, глоссарий, ключевые документы",
      state: "pending",
      title: "Агент пишет бриф",
    },
    {
      detail: "Ссылки на документы, термины для распознавания",
      state: "pending",
      title: "Проверяю и сохраняю",
    },
  ];
}

/** "Бриф готов" from the stored brief. */
function readySummary(
  brief: {
    glossary: unknown[];
    modules: { name: string }[];
    product: string;
    stack: string[];
  } | null,
  people: number,
  documents: ProjectSource[]
) {
  const ready = documents.filter((source) => source.status === "ready");
  const stats: typeof BRIEF_READY.stats = [
    { label: "документов прочитано", value: String(ready.length) },
    { label: "людей клиента", value: String(people) },
    {
      label: "терминов в глоссарии",
      value: String(brief?.glossary.length ?? 0),
    },
  ];
  const facts: typeof BRIEF_READY.facts = [];
  if (brief?.product) {
    facts.push({ label: "Продукт", value: brief.product });
  }
  if (brief && brief.stack.length > 0) {
    facts.push({ label: "Стек", value: brief.stack.join(", ") });
  }
  if (brief && brief.modules.length > 0) {
    facts.push({
      label: "Модули",
      value: brief.modules.map((module) => module.name).join(", "),
    });
  }
  return { facts, stats };
}

interface DraftPerson extends WizardPerson {
  level: string;
}

type NameError = "empty" | "duplicate";

/** `/project/new`: the new project wizard, then the brief build. */
export function NewProjectPage() {
  const router = useRouter();
  const projects = useProjects();
  const demo = useDemoState(NEW_PROJECT_DEMO_STATES);

  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<NameError | null>(null);
  const [people, setPeople] = useState<DraftPerson[]>([]);
  const [notes, setNotes] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  /** Saved as soon as it gets a document: documents belong to a project. */
  const [draftId, setDraftId] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const build = useBriefBuild(projectId);
  const savedId = projectId ?? draftId;
  const saved = useProject(savedId);
  const savedPeople = usePeople(projectId);
  const documents = useProjectSources(savedId);

  // A forced state applies when the demo param changes.
  useEffect(() => {
    if (!demo) {
      return;
    }
    if (demo === "name-error") {
      setStep("name");
      setNameError("empty");
    } else {
      setStep(demo);
    }
  }, [demo]);

  // The focus goes to "Название" on step 1 and back to it after an error.
  useEffect(() => {
    if (step === "name") {
      nameRef.current?.focus();
    }
  }, [step]);

  const duplicate = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return projects.find(
      (project) =>
        project.id !== draftId && project.name.toLowerCase() === needle
    );
  }, [draftId, name, projects]);

  let view: Step = step;
  if (build && build.status !== "stopped") {
    view = build.status === "ready" ? "ready" : "building";
  }
  const failed = build?.status === "failed";
  let screenState: NewProjectState = view;
  if (view === "name" && nameError) {
    screenState = "name-error";
  }

  const dirty =
    name.trim() !== "" ||
    description.trim() !== "" ||
    people.length > 0 ||
    notes.trim() !== "" ||
    draftId !== null;

  /* -------------------------------------------------- Navigation */

  const goNext = useCallback(() => {
    if (step === "name") {
      if (!name.trim()) {
        setNameError("empty");
        nameRef.current?.focus();
        return;
      }
      if (duplicate) {
        setNameError("duplicate");
        nameRef.current?.focus();
        return;
      }
      setStep("sources");
    } else if (step === "sources") {
      setStep("people");
    } else if (step === "people") {
      setStep("notes");
    }
  }, [duplicate, name, step]);

  const goBack = useCallback(() => {
    if (step === "building" || step === "ready") {
      return;
    }
    const previous = PREVIOUS[step];
    if (previous) {
      setStep(previous);
    }
  }, [step]);

  const handleStepClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const target = RAIL_STEP[event.currentTarget.dataset.step ?? ""];
      if (target && !projectId) {
        setStep(target);
      }
    },
    [projectId]
  );

  const handleCancel = useCallback(() => {
    if (dirty) {
      setLeaveOpen(true);
    } else {
      router.push(routes.home());
    }
  }, [dirty, router]);

  const leave = useCallback(() => {
    setLeaveOpen(false);
    // The project made for the documents goes with them.
    if (draftId && !projectId) {
      deleteProject(draftId);
    }
    router.push(routes.home());
  }, [draftId, projectId, router]);

  /* -------------------------------------------------- Step 1 */

  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.target.value);
    setNameError(null);
  }, []);
  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDescription(event.target.value);
    },
    []
  );
  const handleNameKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goNext();
      }
    },
    [goNext]
  );

  /* -------------------------------------------------- Step 2 */

  const documentsBlock = useWizardDocuments({
    active: view === "sources",
    description,
    name,
    onDraft: setDraftId,
    savedId,
  });

  /* -------------------------------------------------- Step 3 */

  const handleAddPerson = useCallback((person: QuickPerson) => {
    setPeople((current) => [
      ...current,
      {
        initials: initialsOf(person.name),
        level: person.level,
        name: person.name,
        role: person.role,
        tag: TECH_TAG[person.level] ?? "",
      },
    ]);
  }, []);

  const handleRemovePerson = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const removedName = event.currentTarget.dataset.name;
      const index = people.findIndex((person) => person.name === removedName);
      const removed = people[index];
      if (!removed) {
        return;
      }
      setPeople((current) => current.filter((person) => person !== removed));
      toast.add({
        actionProps: {
          children: "Вернуть",
          onClick: () =>
            setPeople((current) => [
              ...current.slice(0, index),
              removed,
              ...current.slice(index),
            ]),
        },
        title: "Удалено",
        type: "success",
      });
    },
    [people]
  );

  /* -------------------------------------------------- Step 4 */

  const handleNotes = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setNotes(event.target.value);
  }, []);
  const handleHint = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const { hint } = event.currentTarget.dataset;
    if (!hint) {
      return;
    }
    setNotes((current) => {
      const separator = current && !current.endsWith("\n") ? "\n" : "";
      return `${current}${separator}${hint}: `;
    });
  }, []);

  /* -------------------------------------------------- Brief */

  const handleBuild = useCallback(async () => {
    const projectName = name.trim();
    if (!projectName) {
      setStep("name");
      setNameError("empty");
      return;
    }
    // The project is saved right away with the id the backend gives it
    // (or was, with its first document); the people and the notes go with
    // it, then the agent builds the brief. A failed save (toast) goes back.
    setStep("building");
    const fields = {
      description: description.trim(),
      name: projectName,
      notes: notes.trim(),
    };
    const id = draftId
      ? ((await updateProject(draftId, fields))?.id ?? null)
      : await createProject(fields);
    if (!id) {
      setStep("notes");
      return;
    }
    await Promise.all(
      people.map((person) => {
        const tech = LEVEL_BY_CHOICE[person.level] ?? null;
        return addPerson({
          howToAsk: defaultHowToAsk(tech),
          initials: person.initials,
          name: person.name,
          project: null,
          projectId: id,
          role: person.role,
          tech,
        });
      })
    );
    startBriefBuild(id, projectName);
    setProjectId(id);
  }, [description, draftId, name, notes, people]);

  const handleRetry = useCallback(() => {
    if (projectId) {
      startBriefBuild(projectId, name.trim());
    }
  }, [name, projectId]);

  const handleStop = useCallback(() => {
    if (!projectId) {
      router.push(routes.home());
      return;
    }
    stopBriefBuild(projectId);
    router.push(routes.project(projectId));
    toast.add({
      description: "Проект сохранён, бриф можно собрать на его странице",
      title: "Сбор брифа остановлен",
      type: "info",
    });
  }, [projectId, router]);

  const handleBackground = useCallback(() => {
    if (projectId) {
      const id = projectId;
      sendBriefBuildToBackground(id, () => router.push(routes.project(id)));
    }
    router.push(routes.home());
    toast.add({
      description: "Сообщу, когда бриф будет готов",
      title: "Агент собирает бриф в фоне",
      type: "info",
    });
  }, [projectId, router]);

  /* -------------------------------------------------- Render */

  const projectHref = routes.project(projectId ?? DEMO_PROJECT_ID);
  const isSaved = projectId !== null || view === "ready";
  // The draft has its own item until the wizard is done.
  const sidebarProjects = useMemo(
    () =>
      isSaved
        ? undefined
        : projects.filter((project) => project.id !== draftId),
    [draftId, isSaved, projects]
  );

  let content: ReactNode = null;
  switch (view) {
    case "name":
      content = (
        <ProjectStep
          description={description}
          error={
            nameError === "duplicate" && duplicate ? (
              <>
                Проект с таким названием уже есть,{" "}
                <Link
                  className="underline underline-offset-3"
                  href={routes.project(duplicate.id)}
                >
                  открыть его
                </Link>
              </>
            ) : undefined
          }
          invalid={nameError !== null}
          name={name}
          nameRef={nameRef}
          onDescriptionChange={handleDescription}
          onNameChange={handleName}
          onNameKeyDown={handleNameKey}
        />
      );
      break;
    case "sources":
      content = (
        <SourcesStep
          documents={documentsBlock}
          integrations={<SoonIntegrations />}
        />
      );
      break;
    case "people":
      content = (
        <PeopleStep
          level={LEVEL_UNSET}
          levels={WIZARD_TECH_LEVELS}
          onAdd={handleAddPerson}
          onRemove={handleRemovePerson}
          people={people}
        />
      );
      break;
    case "notes":
      content = (
        <NotesStep
          notes={notes}
          onHint={handleHint}
          onNotesChange={handleNotes}
        />
      );
      break;
    case "building":
      content = (
        <BuildingView
          build={build}
          documents={documents.length}
          people={people.length}
        />
      );
      break;
    default:
      content = (
        <ReadyStep
          assumption={null}
          description="Агент прочитал описание, заметки, людей и документы. Проверьте главное на странице проекта; бриф можно собрать заново в любой момент."
          {...readySummary(saved?.brief ?? null, savedPeople.length, documents)}
        />
      );
  }

  return (
    <>
      <NewProjectScreen
        className="h-svh"
        footer={
          <WizardActions
            failed={failed}
            onBack={goBack}
            onBackground={handleBackground}
            onBuild={handleBuild}
            onCancel={handleCancel}
            onNext={goNext}
            onRetry={handleRetry}
            onStop={handleStop}
            projectHref={projectHref}
            view={view}
          />
        }
        onStepClick={handleStepClick}
        sidebar={
          <MainSidebar
            active={isSaved ? (projectId ?? DEMO_PROJECT_ID) : undefined}
            projects={sidebarProjects}
            projectsEnd={
              isSaved ? null : (
                <DraftProjectNavItem label={name.trim() || "Новый проект"} />
              )
            }
          />
        }
        state={screenState}
      >
        {content}
      </NewProjectScreen>
      <AlertDialog onOpenChange={setLeaveOpen} open={leaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Выйти без сохранения?</AlertDialogTitle>
            <AlertDialogDescription>
              Название, документы, люди и заметки не сохранятся. Проект
              появится, только когда вы дойдёте до «Собрать бриф».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Остаться</AlertDialogCancel>
            <AlertDialogAction onClick={leave} variant="destructive">
              Выйти
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Документы с компьютера" of step 2. Documents belong to a project, so the
 * first of them saves it (`onDraft` gets its id); the wizard fills it in
 * at "Собрать бриф". Files dropped on the window count while `active`.
 */
function useWizardDocuments({
  active,
  description,
  name,
  onDraft,
  savedId,
}: {
  active: boolean;
  description: string;
  name: string;
  onDraft: (id: string) => void;
  savedId: string | null;
}) {
  const documents = useProjectSources(savedId);
  const { add, adding, rejected } = useAddDocuments(savedId);

  const ensureDraft = useCallback(async () => {
    if (savedId) {
      return savedId;
    }
    const id = await createProject({
      description: description.trim(),
      name: name.trim(),
    });
    if (id) {
      onDraft(id);
    }
    return id ?? null;
  }, [description, name, onDraft, savedId]);

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }
      const id = await ensureDraft();
      if (id) {
        await add(paths, id);
      }
    },
    [add, ensureDraft]
  );
  const handlePick = useCallback(async () => {
    await addPaths(await pickDocuments());
  }, [addPaths]);
  const handleDrop = useCallback(
    (paths: string[]) => {
      addPaths(paths);
    },
    [addPaths]
  );
  const dropActive = useDocumentDrop(active ? handleDrop : null);
  const handleRemove = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const sourceId = event.currentTarget.dataset.id;
    if (sourceId) {
      removeProjectSource(sourceId);
    }
  }, []);

  return (
    <DocumentsBlock
      adding={adding}
      documents={documents}
      dropActive={dropActive}
      dropSupported={documentDropSupported}
      onPick={handlePick}
      onRemove={handleRemove}
      rejected={rejected}
    />
  );
}

/** "Собираю бриф" at the build's real stage, or why it failed. */
function BuildingView({
  build,
  documents,
  people,
}: {
  build: ReturnType<typeof useBriefBuild>;
  documents: number;
  people: number;
}) {
  return (
    <BuildingStep
      error={build?.status === "failed" ? build.error : undefined}
      stage={build ? Math.min(build.stage + 1, BRIEF_BUILD_STAGES) : undefined}
      tasks={buildTasks(people, documents)}
    />
  );
}

/** The footer of each step: text action on the left, step buttons right. */
function WizardActions({
  failed,
  onBack,
  onBackground,
  onBuild,
  onCancel,
  onNext,
  onRetry,
  onStop,
  projectHref,
  view,
}: {
  /** The build failed: try again, or open the saved project. */
  failed: boolean;
  onBack: () => void;
  onBackground: () => void;
  onBuild: () => void;
  onCancel: () => void;
  onNext: () => void;
  onRetry: () => void;
  onStop: () => void;
  projectHref: string;
  view: Step;
}) {
  if (view === "building" && failed) {
    return (
      <WizardFooter
        end={<WizardButton onClick={onRetry}>Собрать ещё раз</WizardButton>}
        start={
          <WizardTextAction {...linkButtonProps(projectHref)}>
            Открыть проект
          </WizardTextAction>
        }
      />
    );
  }
  if (view === "building") {
    return (
      <WizardFooter
        end={
          <WizardButton onClick={onBackground} variant="secondary">
            Свернуть в фон
          </WizardButton>
        }
        start={<WizardTextAction onClick={onStop}>Остановить</WizardTextAction>}
      />
    );
  }
  if (view === "ready") {
    return (
      <WizardFooter
        end={
          <WizardButton {...linkButtonProps(projectHref)}>
            Открыть проект
          </WizardButton>
        }
        start={
          <WizardTextAction {...linkButtonProps(routes.home())}>
            На главную
          </WizardTextAction>
        }
      />
    );
  }

  const back =
    view === "name" ? null : (
      <WizardButton onClick={onBack} variant="secondary">
        Назад
      </WizardButton>
    );
  const forward =
    view === "notes" ? (
      <WizardButton onClick={onBuild}>Собрать бриф</WizardButton>
    ) : (
      <WizardButton hint={view === "name" ? "⏎" : undefined} onClick={onNext}>
        Далее
      </WizardButton>
    );

  return (
    <WizardFooter
      end={
        <>
          {back}
          {forward}
        </>
      }
      start={<WizardTextAction onClick={onCancel}>Отмена</WizardTextAction>}
    />
  );
}
