import type { FormEvent, MouseEvent, ReactNode } from "react";
import { useId } from "react";

import { MainSidebar } from "@/features/shell/app-sidebar";
import { MainWindow, TitlebarSearch } from "@/features/shell/main-window";
import { routes } from "@/lib/routes";

import {
  AskStyle,
  ManagerNotes,
  Portrait,
  ProfileEditActions,
  ProfileHeader,
  ProfileSide,
  ProfileSuggestion,
  ProfileViewActions,
  ScaleCard,
} from "../components/person-profile";
import { BreadcrumbChevronIcon } from "../icons";
import { PERSON, PROJECT } from "../mock";
import type { PersonProfile } from "../project-data";

/** `data-slot` of the edit form, for the ⌘S shortcut. */
export const PERSON_FORM_SLOT = "person-form";

/** The call the demo suggestion was heard on, and the moment of the quote. */
const SUGGESTION_CALL_ID = "telemedia-19-oct";
const SUGGESTION_MOMENT = "12:14";

/** Pending proposals of one call about the person, for its review. */
export interface CallSuggestion {
  /** The call's id. */
  id: string;
  /** The quote's moment in the call transcript. */
  quoteHref?: string;
  /** The call's review of proposals. */
  reviewHref: string;
  suggestion: {
    changes: { field: string; text: string }[];
    quote?: string;
    title: string;
  };
}

/*
 * 13 Человек: the profile of a person of the client with the suggestion
 * after the call. 14 (`mode="edit"`): every field editable in place. The
 * app passes the person's pending proposals of each call
 * (`callSuggestions`), reviewed on the call's page; without them (`/dev`)
 * the demo suggestion.
 *
 * In edit mode the fields sit in a form; `onSave` gets its submit event
 * (fields: role, askStyle, portrait:<label>).
 */
export function PersonScreen({
  className,
  mode = "view",
  onCancelEdit,
  onEdit,
  onSave,
  onScaleStep,
  callSuggestions,
  person = PERSON,
  project = PROJECT,
  suggestion = true,
}: {
  /** The person's pending proposals, a block per call. */
  callSuggestions?: CallSuggestion[];
  className?: string;
  mode?: "view" | "edit";
  onCancelEdit?: () => void;
  onEdit?: () => void;
  onSave?: (event: FormEvent<HTMLFormElement>) => void;
  /** A step of a scale in edit mode: `data-scale` is "tech" or "project". */
  onScaleStep?: (event: MouseEvent<HTMLButtonElement>) => void;
  person?: PersonProfile;
  project?: { id: string; name: string };
  /** Show the suggested edit after the last call. */
  suggestion?: boolean;
}) {
  const editing = mode === "edit";
  const formId = useId();

  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      sidebar={<MainSidebar active={project.id} />}
      title={
        <>
          {project.name}
          <BreadcrumbChevronIcon className="text-subtle size-3 shrink-0" />
          <span className="text-muted-foreground font-normal">
            {person.name}
          </span>
        </>
      }
    >
      <main className="flex gap-12 px-12 pt-9 pb-12">
        <ProfileColumn formId={editing ? formId : undefined} onSave={onSave}>
          <ProfileHeader
            actions={
              editing ? (
                <ProfileEditActions
                  form={onSave ? formId : undefined}
                  onCancel={onCancelEdit}
                />
              ) : (
                <ProfileViewActions onEdit={onEdit} />
              )
            }
            editing={editing}
            initials={person.initials}
            name={person.name}
            role={person.role}
          />
          {!editing && callSuggestions
            ? callSuggestions.map((item) => (
                <ProfileSuggestion
                  key={item.id}
                  quoteHref={item.quoteHref}
                  reviewHref={item.reviewHref}
                  suggestion={item.suggestion}
                />
              ))
            : null}
          {suggestion && !editing && !callSuggestions && person.suggestion ? (
            <ProfileSuggestion
              quoteHref={routes.callTranscript(
                SUGGESTION_CALL_ID,
                SUGGESTION_MOMENT
              )}
              suggestion={person.suggestion}
            />
          ) : null}
          <AskStyle
            editing={editing}
            example={person.askExample}
            label={
              person.whom
                ? `Как формулировать вопросы для ${person.whom}`
                : "Как формулировать вопросы"
            }
            text={editing ? person.askStyleEdited : person.askStyle}
          />
          <div className="flex gap-4">
            <ScaleCard
              className="flex-1"
              editing={editing}
              onStepClick={onScaleStep}
              scale={person.scales.tech}
              scaleKey="tech"
            />
            <ScaleCard
              className="flex-1"
              editing={editing}
              onStepClick={onScaleStep}
              scale={person.scales.project}
              scaleKey="project"
            />
          </div>
          <Portrait editing={editing} rows={person.portrait} />
          {person.notes === undefined ? null : (
            <ManagerNotes editing={editing} text={person.notes} />
          )}
        </ProfileColumn>
        <ProfileSide
          calls={person.calls}
          firstName={person.firstName}
          origin={person.origin}
        />
      </main>
    </MainWindow>
  );
}

/** The main column; a form in edit mode, so ⏎ and "Сохранить" submit it. */
function ProfileColumn({
  children,
  formId,
  onSave,
}: {
  children: ReactNode;
  formId?: string;
  onSave?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const className = "flex min-w-0 flex-1 flex-col gap-7";
  if (formId) {
    return (
      <form
        className={className}
        data-slot={PERSON_FORM_SLOT}
        id={formId}
        onSubmit={onSave}
      >
        {children}
      </form>
    );
  }
  return <div className={className}>{children}</div>;
}
