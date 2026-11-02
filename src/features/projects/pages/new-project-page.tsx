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
import { useIntegrations } from "@/data/integrations";
import { addPerson, initialsOf } from "@/data/people";
import { createProject, useProjects } from "@/data/projects";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import {
  sendBriefBuildToBackground,
  startBriefBuild,
  stopBriefBuild,
  useBriefBuild,
} from "../api";
import { BRIEF_BUILD_STAGES } from "../backend";
import {
  DraftProjectNavItem,
  WizardButton,
  WizardFooter,
  WizardTextAction,
} from "../components/wizard-layout";
import type { QuickPerson } from "../components/wizard-people";
import {
  DEMO_PROJECT_ID,
  defaultHowToAsk,
  LEVEL_BY_CHOICE,
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

const TECH_TAG: Record<string, string> = {
  medium: "средне",
  none: "не технарь",
  tech: "технарь",
};

interface DraftPerson extends WizardPerson {
  level: string;
}

type NameError = "empty" | "duplicate";

/** `/project/new`: the new project wizard, then the brief build. */
export function NewProjectPage() {
  const router = useRouter();
  const projects = useProjects();
  const integrations = useIntegrations();
  const demo = useDemoState(NEW_PROJECT_DEMO_STATES);

  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<NameError | null>(null);
  const [people, setPeople] = useState<DraftPerson[]>([]);
  const [notes, setNotes] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const build = useBriefBuild(projectId);

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
    return projects.find((project) => project.name.toLowerCase() === needle);
  }, [name, projects]);

  let view: Step = step;
  if (build) {
    view = build.status === "ready" ? "ready" : "building";
  }
  let screenState: NewProjectState = view;
  if (view === "name" && nameError) {
    screenState = "name-error";
  }

  const dirty =
    name.trim() !== "" ||
    description.trim() !== "" ||
    people.length > 0 ||
    notes.trim() !== "";

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
    router.push(routes.home());
  }, [router]);

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

  const handleBuild = useCallback(() => {
    const projectName = name.trim();
    if (!projectName) {
      setStep("name");
      setNameError("empty");
      return;
    }
    // The project is saved right away with the id the backend gives it;
    // the agent builds the brief after. A failed save (toast) goes back.
    setStep("building");
    createProject({
      description: description.trim(),
      name: projectName,
    }).then((id) => {
      if (!id) {
        setStep("notes");
        return;
      }
      for (const person of people) {
        const tech = LEVEL_BY_CHOICE[person.level] ?? 3;
        addPerson({
          howToAsk: defaultHowToAsk(tech),
          initials: person.initials,
          name: person.name,
          notes: notes.trim() || undefined,
          project: 2,
          projectId: id,
          role: person.role,
          tech,
        });
      }
      startBriefBuild(id, projectName);
      setProjectId(id);
    });
  }, [description, name, notes, people]);

  const handleStop = useCallback(() => {
    if (!projectId) {
      router.push(routes.home());
      return;
    }
    stopBriefBuild(projectId);
    router.push(routes.project(projectId));
    toast.add({
      description: "Проект сохранён, бриф можно собрать кнопкой «Обновить»",
      title: "Сбор брифа остановлен",
      type: "info",
    });
  }, [projectId, router]);

  const handleBackground = useCallback(() => {
    if (projectId) {
      sendBriefBuildToBackground(projectId);
    }
    router.push(routes.home());
    toast.add({
      description: "Сообщу, когда бриф будет готов",
      title: "Агент собирает бриф в фоне",
      type: "info",
    });
  }, [projectId, router]);

  /* -------------------------------------------------- Render */

  const sources = useMemo(
    () => ({
      clickup: {
        account: integrations.clickup.account,
        connected: integrations.clickup.status === "connected",
      },
      github: {
        account: integrations.github.account,
        connected: integrations.github.status === "connected",
      },
      outline: {
        account: integrations.outline.account,
        connected: integrations.outline.status === "connected",
      },
    }),
    [integrations]
  );

  const projectHref = routes.project(projectId ?? DEMO_PROJECT_ID);
  const isSaved = projectId !== null || view === "ready";

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
          connectHref={routes.settings("integrations")}
          sources={sources}
        />
      );
      break;
    case "people":
      content = (
        <PeopleStep
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
        <BuildingStep
          stage={
            build ? Math.min(build.stage + 1, BRIEF_BUILD_STAGES) : undefined
          }
        />
      );
      break;
    default:
      content = <ReadyStep />;
  }

  return (
    <>
      <NewProjectScreen
        className="h-svh"
        footer={
          <WizardActions
            onBack={goBack}
            onBackground={handleBackground}
            onBuild={handleBuild}
            onCancel={handleCancel}
            onNext={goNext}
            onStop={handleStop}
            projectHref={projectHref}
            view={view}
          />
        }
        onStepClick={handleStepClick}
        sidebar={
          <MainSidebar
            active={isSaved ? (projectId ?? DEMO_PROJECT_ID) : undefined}
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
              Название, люди и заметки не сохранятся. Проект появится, только
              когда вы дойдёте до «Собрать бриф».
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

/** The footer of each step: text action on the left, step buttons right. */
function WizardActions({
  onBack,
  onBackground,
  onBuild,
  onCancel,
  onNext,
  onStop,
  projectHref,
  view,
}: {
  onBack: () => void;
  onBackground: () => void;
  onBuild: () => void;
  onCancel: () => void;
  onNext: () => void;
  onStop: () => void;
  projectHref: string;
  view: Step;
}) {
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
