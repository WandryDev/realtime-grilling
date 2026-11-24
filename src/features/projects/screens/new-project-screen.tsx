import { Alert, AlertDescription, AlertTitle } from "@grill/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grill/ui/field";
import { Input } from "@grill/ui/input";
import { Textarea } from "@grill/ui/textarea";
import type {
  ChangeEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import {
  DESCRIPTION_LIMIT_HINT,
  DESCRIPTION_MAX_CHARS,
} from "@/data/project-limits";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { MainWindow, TitlebarSearch } from "@/features/shell/main-window";

import {
  AssumptionNote,
  BriefBuildProgress,
  BriefFacts,
  BriefStats,
  BriefTaskList,
  ManagerNotesField,
  NoteHints,
} from "../components/wizard-brief";
import {
  DraftProjectNavItem,
  WizardButton,
  WizardFooter,
  WizardForm,
  WizardHeading,
  WizardLayout,
  type WizardStepEntry,
  type WizardStepState,
  WizardSteps,
  WizardTextAction,
} from "../components/wizard-layout";
import {
  PersonLine,
  QuickAddPerson,
  type QuickPerson,
} from "../components/wizard-people";
import {
  RepoPicker,
  SourceBlock,
  SourceSelect,
} from "../components/wizard-sources";
import {
  BRIEF_READY,
  BRIEF_TASKS,
  type BriefTaskState,
  MANAGER_NOTES,
  NEW_PROJECT_DRAFT,
  NOTE_HINTS,
  QUICK_TECH_LEVELS,
  READY_SIDEBAR_PROJECTS,
  WIZARD_PEOPLE,
  WIZARD_REPOS,
  WIZARD_SIDEBAR_PROJECTS,
  WIZARD_STEPS,
  type WizardStepId,
} from "../mock";

/** Stage the preview of "Собираю бриф" shows: GitHub is being read. */
const PREVIEW_BUILD_STAGE = 3;

/*
 * 03–09 Новый проект: the wizard in the main panel, one state per artboard.
 * - name, name-error: step 1, the project and its description
 * - sources: step 2, what to read in Outline, GitHub, ClickUp
 * - people: step 3, the people of the client
 * - notes: step 4, what only the manager knows
 * - building: the agent builds the brief (step 5 is working)
 * - ready: the brief is ready, the project is saved
 */
export type NewProjectState =
  | "name"
  | "name-error"
  | "sources"
  | "people"
  | "notes"
  | "building"
  | "ready";

const STATE_STEP: Record<NewProjectState, WizardStepId> = {
  building: "brief",
  name: "project",
  "name-error": "project",
  notes: "notes",
  people: "people",
  ready: "brief",
  sources: "sources",
};

/** Step of the rail each state belongs to. */
export function wizardStepOf(state: NewProjectState): WizardStepId {
  return STATE_STEP[state];
}

function stepEntries(state: NewProjectState): WizardStepEntry[] {
  const currentIndex = WIZARD_STEPS.findIndex(
    (step) => step.id === STATE_STEP[state]
  );
  return WIZARD_STEPS.map((step, index) => {
    let stepState: WizardStepState = "pending";
    if (index < currentIndex || state === "ready") {
      stepState = "done";
    } else if (index === currentIndex) {
      stepState = state === "building" ? "working" : "current";
    }
    let description: string = step.description;
    if (step.id === "brief" && state === "building") {
      description = "Агент работает";
    } else if (step.id === "brief" && state === "ready") {
      description = "Готово за 2 мин";
    }
    return { description, id: step.id, state: stepState, title: step.title };
  });
}

/*
 * Without overrides it is the static Paper artboard of `state`. The app
 * passes the live step (`children`), `footer`, `sidebar` and `onStepClick`.
 */
export function NewProjectScreen({
  children,
  className,
  footer,
  onStepClick,
  sidebar,
  state = "name",
}: {
  /** The live step; the static one of `state` when not set. */
  children?: ReactNode;
  className?: string;
  footer?: ReactNode;
  /** A finished step in the rail; its id is in `data-step`. */
  onStepClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  sidebar?: ReactNode;
  state?: NewProjectState;
}) {
  const isReady = state === "ready";

  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      sidebar={
        sidebar ?? (
          <MainSidebar
            active={isReady ? "telemedia" : undefined}
            projects={
              isReady ? READY_SIDEBAR_PROJECTS : WIZARD_SIDEBAR_PROJECTS
            }
            projectsEnd={isReady ? null : <DraftProjectNavItem />}
          />
        )
      }
    >
      <WizardLayout
        footer={footer ?? <NewProjectFooter state={state} />}
        steps={
          <WizardSteps onStepClick={onStepClick} steps={stepEntries(state)} />
        }
      >
        {children ?? <NewProjectStep state={state} />}
      </WizardLayout>
    </MainWindow>
  );
}

function NewProjectStep({ state }: { state: NewProjectState }) {
  switch (state) {
    case "name":
    case "name-error":
      return <ProjectStep invalid={state === "name-error"} />;
    case "sources":
      return <SourcesStep />;
    case "people":
      return <PeopleStep />;
    case "notes":
      return <NotesStep />;
    case "building":
      return <BuildingStep />;
    case "ready":
      return <ReadyStep />;
    default:
      return null;
  }
}

/**
 * Step 1. Static with the Paper draft in the preview; with `onNameChange`
 * the fields are controlled and `error` explains what is wrong.
 */
export function ProjectStep({
  description,
  error,
  invalid,
  name,
  nameRef,
  onDescriptionChange,
  onNameChange,
  onNameKeyDown,
}: {
  description?: string;
  error?: ReactNode;
  invalid: boolean;
  name?: string;
  nameRef?: Ref<HTMLInputElement>;
  onDescriptionChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onNameChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onNameKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const live = Boolean(onNameChange);
  return (
    <WizardForm className="gap-8 pt-14">
      <WizardHeading
        description="Пара предложений своими словами. Агент возьмёт это за отправную точку брифа и уточнит по документам."
        title="Что за проект?"
      />
      <Field invalid={invalid}>
        <FieldLabel className="text-sm font-medium">Название</FieldLabel>
        <Input
          autoComplete="off"
          className="px-3.5"
          data-preview={live ? undefined : "focus"}
          defaultValue={live || invalid ? undefined : NEW_PROJECT_DRAFT.name}
          onChange={onNameChange}
          onKeyDown={onNameKeyDown}
          placeholder="Например, Телемедиа"
          ref={nameRef}
          value={live ? name : undefined}
        />
        {invalid ? (
          <FieldError>
            {error ??
              "Нужно название, по нему вы выберете проект в начале звонка"}
          </FieldError>
        ) : null}
      </Field>
      <Field>
        <div className="flex justify-between gap-4">
          <FieldLabel className="text-sm font-medium">Описание</FieldLabel>
          <span className="text-muted-foreground text-sm">необязательно</span>
        </div>
        <Textarea
          className="min-h-30 px-3.5 py-3"
          defaultValue={
            live || invalid ? undefined : NEW_PROJECT_DRAFT.description
          }
          maxLength={DESCRIPTION_MAX_CHARS}
          onChange={onDescriptionChange}
          placeholder="Чем занимается клиент и что мы делаем"
          value={live ? description : undefined}
        />
        <FieldDescription>{DESCRIPTION_LIMIT_HINT}</FieldDescription>
      </Field>
    </WizardForm>
  );
}

export interface WizardSource {
  /** "подключено как …"; Paper's text when not set. */
  account?: string;
  connected: boolean;
}

/**
 * Step 2. The app passes `documents` ("Документы с компьютера") and
 * `integrations` (Outline, GitHub, ClickUp «скоро») until the integrations
 * come. The preview draws Paper's integration blocks: `sources` says which
 * services are connected (all by default); a missing one offers
 * "Подключить …" at `connectHref`.
 */
export function SourcesStep({
  connectHref,
  documents,
  integrations,
  sources,
}: {
  connectHref?: string;
  documents?: ReactNode;
  integrations?: ReactNode;
  sources?: Partial<Record<"outline" | "github" | "clickup", WizardSource>>;
}) {
  if (documents) {
    return (
      <WizardForm>
        <WizardHeading
          description="Всё необязательно. Агент прочитает текст документов и соберёт по ним бриф. Документы можно добавить позже на странице проекта."
          title="Откуда брать контекст"
        />
        <div className="flex flex-col gap-7">
          {documents}
          {integrations}
        </div>
      </WizardForm>
    );
  }
  const outline = sources?.outline;
  const github = sources?.github;
  const clickup = sources?.clickup;
  return (
    <WizardForm>
      <WizardHeading
        description="Всё необязательно. Агент только читает и ничего не меняет. Источники можно добавить позже на странице проекта."
        title="Откуда брать контекст"
      />
      <div className="flex flex-col gap-12">
        <SourceBlock
          connected={outline?.connected ?? true}
          connectHref={connectHref}
          description={sourceDescription(
            "Документация",
            outline,
            "docs.studio-kraft.com"
          )}
          kind="outline"
          name="Outline"
        >
          <SourceSelect
            defaultValue="telemedia"
            label="Коллекция"
            options={[
              { label: "Телемедиа", meta: "48 документов", value: "telemedia" },
              { label: "Ветклиника Лапа", meta: "21 документ", value: "lapa" },
            ]}
          />
        </SourceBlock>
        <SourceBlock
          connected={github?.connected ?? true}
          connectHref={connectHref}
          description={sourceDescription("Код", github, "dima-kraft")}
          kind="github"
          name="GitHub"
        >
          <RepoPicker
            hovered="telemedia/mobile"
            query="telemedia"
            repos={WIZARD_REPOS}
          />
        </SourceBlock>
        <SourceBlock
          connected={clickup?.connected ?? true}
          connectHref={connectHref}
          description={
            clickup?.connected === false
              ? "Задачи и комментарии, не подключено"
              : "Задачи и комментарии, только чтение"
          }
          kind="clickup"
          name="ClickUp"
        >
          <SourceSelect
            defaultValue="clients"
            label="Пространство"
            options={[
              { label: "Клиенты", value: "clients" },
              { label: "Студия", value: "studio" },
            ]}
          />
          <SourceSelect
            defaultValue="telemedia-1"
            label="Список"
            options={[
              {
                label: "Телемедиа, этап 1",
                meta: "36 задач",
                value: "telemedia-1",
              },
              { label: "Ветклиника Лапа", meta: "12 задач", value: "lapa" },
            ]}
          />
        </SourceBlock>
      </div>
    </WizardForm>
  );
}

function sourceDescription(
  what: string,
  source: WizardSource | undefined,
  fallback: string
) {
  if (source?.connected === false) {
    return `${what}, не подключено`;
  }
  return `${what}, подключено как ${source?.account ?? fallback}`;
}

export interface WizardPerson {
  initials: string;
  name: string;
  role: string;
  tag: string;
}

/**
 * Step 3. The preview shows Paper's two people and a half-typed third; the
 * app adds "не указано" to the tech levels (`levels`, `level`).
 */
export function PeopleStep({
  level = "medium",
  levels = QUICK_TECH_LEVELS,
  onAdd,
  onRemove,
  people = WIZARD_PEOPLE,
}: {
  level?: string;
  levels?: { label: string; value: string }[];
  onAdd?: (person: QuickPerson) => void;
  onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
  people?: WizardPerson[];
}) {
  return (
    <WizardForm>
      <WizardHeading
        description="Достаточно имени и роли. От тех. уровня зависит, как агент сформулирует вопрос. Остальное Grill допишет после звонков, с вашего согласия."
        title="Кто будет на звонках"
      />
      {people.length > 0 ? (
        <ul aria-label="Люди клиента" className="flex flex-col gap-5">
          {people.map((person) => (
            <li key={person.name}>
              <PersonLine {...person} onRemove={onRemove} />
            </li>
          ))}
        </ul>
      ) : null}
      <QuickAddPerson
        defaultName={onAdd ? undefined : "Марина Ковальчук"}
        level={level}
        levels={levels}
        onAdd={onAdd}
      />
      <p className="text-muted-foreground text-sm">
        Темперамент, характер и понимание проекта можно заполнить потом в
        профиле человека.
      </p>
    </WizardForm>
  );
}

/** Step 4. Controlled when `onNotesChange` is set. */
export function NotesStep({
  notes = MANAGER_NOTES,
  onHint,
  onNotesChange,
}: {
  notes?: string;
  onHint?: (event: MouseEvent<HTMLButtonElement>) => void;
  onNotesChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <WizardForm>
      <WizardHeading
        description="Договорённости с прошлых встреч, боли клиента, острые темы. Агент добавит это в бриф и будет учитывать на звонках. Можно списком, как удобно."
        title="Что знаете только вы"
      />
      <ManagerNotesField onChange={onNotesChange} value={notes} />
      <NoteHints hints={NOTE_HINTS} onHint={onHint} />
    </WizardForm>
  );
}

/** What the agent does at `stage` (1-based): done before, working on it. */
function briefTasksAt(
  stage: number,
  tasks: typeof BRIEF_TASKS = BRIEF_TASKS
): typeof BRIEF_TASKS {
  return tasks.map((task, index) => {
    let state: BriefTaskState = "pending";
    if (index < stage - 1) {
      state = "done";
    } else if (index === stage - 1) {
      state = "working";
    }
    return { ...task, state };
  });
}

/**
 * "Собираю бриф": the progress and the live list at `stage` of 5. The app
 * passes its `tasks` (the real stages); `error` says why the build failed,
 * `notice` stands in its place for a build a threshold of Grill held back.
 */
export function BuildingStep({
  error,
  notice,
  stage = PREVIEW_BUILD_STAGE,
  tasks: stageTasks,
}: {
  error?: string;
  /** In place of the progress and of `error`. */
  notice?: ReactNode;
  stage?: number;
  tasks?: typeof BRIEF_TASKS;
}) {
  const stages = (stageTasks ?? BRIEF_TASKS).length;
  const tasks =
    stage === PREVIEW_BUILD_STAGE && !stageTasks
      ? BRIEF_TASKS
      : briefTasksAt(stage, stageTasks);
  return (
    <WizardForm>
      <WizardHeading
        description="Обычно это занимает пару минут. Можно свернуть, агент доделает в фоне и пришлёт уведомление."
        title="Собираю бриф проекта"
      />
      {notice ??
        (error ? (
          <Alert variant="destructive">
            <AlertTitle>Не удалось собрать бриф</AlertTitle>
            <AlertDescription>
              {error}. Проект сохранён, бриф можно собрать ещё раз.
            </AlertDescription>
          </Alert>
        ) : (
          <BriefBuildProgress
            eta={stage < stages - 1 ? "~1 мин" : "~10 с"}
            stage={stage}
            stages={stages}
          />
        ))}
      <BriefTaskList tasks={tasks} />
    </WizardForm>
  );
}

/** "Бриф готов": Paper's summary, or the app's from the stored brief. */
export function ReadyStep({
  assumption = BRIEF_READY.assumption,
  description = "Агент прочитал документы, код и задачи. Проверьте главное на странице проекта, исправить можно в любой момент.",
  facts = BRIEF_READY.facts,
  stats = BRIEF_READY.stats,
}: {
  /** A mismatch the agent resolved; `null` hides the note. */
  assumption?: typeof BRIEF_READY.assumption | null;
  description?: string;
  facts?: typeof BRIEF_READY.facts;
  stats?: typeof BRIEF_READY.stats;
}) {
  return (
    <WizardForm>
      <WizardHeading description={description} title="Бриф готов" />
      <BriefStats stats={stats} />
      {facts.length > 0 ? <BriefFacts facts={facts} /> : null}
      {assumption ? <AssumptionNote {...assumption} /> : null}
    </WizardForm>
  );
}

function NewProjectFooter({ state }: { state: NewProjectState }) {
  let start: ReactNode = <WizardTextAction>Отмена</WizardTextAction>;
  let end: ReactNode;

  switch (state) {
    case "building":
      start = <WizardTextAction>Остановить</WizardTextAction>;
      end = <WizardButton variant="secondary">Свернуть в фон</WizardButton>;
      break;
    case "ready":
      start = <WizardTextAction>На главную</WizardTextAction>;
      end = <WizardButton>Открыть проект</WizardButton>;
      break;
    case "notes":
      end = (
        <>
          <WizardButton variant="secondary">Назад</WizardButton>
          <WizardButton hint="⏎">Собрать бриф</WizardButton>
        </>
      );
      break;
    case "name":
    case "name-error":
      end = <WizardButton hint="⏎">Далее</WizardButton>;
      break;
    default:
      end = (
        <>
          <WizardButton variant="secondary">Назад</WizardButton>
          <WizardButton hint="⏎">Далее</WizardButton>
        </>
      );
  }

  return <WizardFooter end={end} start={start} />;
}
