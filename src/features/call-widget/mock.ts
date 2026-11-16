/*
 * Demo data for the floating call widgets, text verbatim from the Paper page
 * "Звонок" (desktop scenes 01, 05, 06).
 */

export interface PickerProject {
  /** Who and when: "Ольга, Игорь, вчера". */
  detail: string;
  id: string;
  /** Last call, shown in the closed field: "был вчера". */
  lastCall?: string;
  name: string;
}

export interface Participant {
  /** How technical they are, "в технике: технарь": the chip's hint. */
  detail?: string;
  /** "Ольги", for "Профили Ольги и Игоря". */
  genitive?: string;
  id: string;
  initials: string;
  /** "Ольгой", for "с Ольгой и Игорем". */
  instrumental?: string;
  name: string;
}

export type BriefStepStatus = "done" | "active" | "pending";

export interface BriefStepItem {
  id: string;
  label: string;
  /** Right-aligned count while the step runs: "12 док.". */
  meta?: string;
  status: BriefStepStatus;
}

export type OverlayQuestionMark = "contradiction";

export interface OverlayQuestionItem {
  /** Muted line under the question: why ask, or when it was asked. */
  description?: string;
  id: string;
  mark?: OverlayQuestionMark;
  title: string;
  /** The question's topic, shown in the final check. */
  topic?: string;
}

export const PICKER_PROJECTS: PickerProject[] = [
  {
    detail: "Ольга, Игорь, вчера",
    id: "telemedia",
    lastCall: "был вчера",
    name: "Телемедиа",
  },
  { detail: "Наталья, 3 дня назад", id: "lapa", name: "Ветклиника Лапа" },
  {
    detail: "Сергей, Анна, неделю назад",
    id: "logistic-pro",
    name: "Логистик Про",
  },
  { detail: "Ещё не звонили", id: "rhythm", name: "Школа Ритм" },
];

export const CALL_PARTICIPANTS: Participant[] = [
  { id: "olga", initials: "ОД", name: "Ольга" },
  { id: "igor", initials: "ИС", name: "Игорь" },
];

export const MEETING_APP = "Zoom";

/** The project of the running call. */
export const CALL_PROJECT = "Телемедиа";

export const BRIEF_STEPS: BriefStepItem[] = [
  { id: "agent", label: "Claude Code на связи", status: "done" },
  { id: "profiles", label: "Профили Ольги и Игоря", status: "done" },
  {
    id: "outline",
    label: "Освежаю бриф по Outline",
    meta: "12 док.",
    status: "active",
  },
  { id: "clickup", label: "Ищу вопросы в ClickUp", status: "pending" },
];

export const LAUNCH = {
  caption:
    "Обычно до полуминуты. Первые вопросы появятся, когда станет понятна тема.",
  description:
    "Телемедиа, с Ольгой и Игорем. Можно говорить, расшифровка уже идёт.",
  /** Percent of the brief prepared. */
  progress: 58,
  time: "00:06",
};

export const MIC_RELEASED = {
  /** Time left before the call ends by itself. */
  countdown: "6:48",
  /** Percent of the countdown already passed. */
  elapsed: 68,
  releasedAt: "12:39",
  time: "39:04",
};

export const OVERLAY_TOPIC = "Интеграция с CRM";

export const OVERLAY_MAIN_QUESTION =
  "Записывать в CRM сам звонок или только факт и длительность?";

export const OVERLAY_QUESTIONS: OverlayQuestionItem[] = [
  {
    id: "mobile",
    mark: "contradiction",
    title: "Мобильное приложение входит в первый этап?",
  },
  {
    description: "В коде уже есть клиент amoCRM",
    id: "amocrm",
    title: "Используем текущую интеграцию с amoCRM или делаем новую?",
  },
];

export const FINAL_CHECK_QUESTIONS: OverlayQuestionItem[] = [
  {
    id: "mobile",
    mark: "contradiction",
    title: "Мобильное приложение входит в первый этап?",
    topic: "Приём звонков",
  },
  {
    description: "Спросили в 12:14, ответа не было",
    id: "operators",
    title: "Что происходит, если все операторы заняты?",
    topic: "Приём звонков",
  },
];

export const OVERLAY = {
  finalCheckDescription:
    "Разговор идёт к концу. Самое важное по всем темам, пока все на связи.",
  /** Questions of the final check that didn't fit, left in the call window. */
  finalCheckMore: 1,
  /** Open questions of the current topic, on the collapsed pill. */
  openQuestions: 5,
  /** Unclosed questions in earlier topics. */
  pastTopics: 2,
  time: "24:18",
  timeFinalCheck: "38:42",
};

/*
 * Russian cases of the demo first names, for "Профили Ольги и Игоря" and
 * "с Ольгой и Игорем". Unknown names fall back to the plain name.
 */
export const NAME_FORMS: Record<
  string,
  { genitive: string; instrumental: string }
> = {
  Анна: { genitive: "Анны", instrumental: "Анной" },
  Игорь: { genitive: "Игоря", instrumental: "Игорем" },
  Наталья: { genitive: "Натальи", instrumental: "Натальей" },
  Нина: { genitive: "Нины", instrumental: "Ниной" },
  Ольга: { genitive: "Ольги", instrumental: "Ольгой" },
  Сергей: { genitive: "Сергея", instrumental: "Сергеем" },
};

/** The project of the last call: the start widget preselects it. */
export const LAST_CALL_PROJECT_ID = "telemedia";

/** Who was on the last call of each project, preselected in the widget. */
export const LAST_CALL_PARTICIPANTS: Record<string, string[]> = {
  telemedia: ["olga", "igor"],
};

/** Questions the agent comes up with while the overlay is open. */
export const INCOMING_QUESTIONS: string[] = [
  "Кто в клинике видит историю звонков пациента?",
  "Нужна ли запись разговора для разбора жалоб?",
  "Сколько операторов работает в пиковые часы?",
  "Что делать с пропущенными звонками ночью?",
];
