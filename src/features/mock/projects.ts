/*
 * Shared demo data for the screens: the four projects from the Paper file.
 * Screens import from here so names and counts match across flows.
 */

export interface MockProject {
  description: string;
  id: string;
  /** Letter on the project tile. */
  initial: string;
  name: string;
  /** Open questions, shown as the sidebar count. */
  openQuestions: number;
}

export const PROJECTS: MockProject[] = [
  {
    description: "Приём звонков для сети клиник, интеграция с amoCRM",
    id: "telemedia",
    initial: "Т",
    name: "Телемедиа",
    openQuestions: 7,
  },
  {
    description: "Онлайн-запись и напоминания владельцам питомцев",
    id: "lapa",
    initial: "В",
    name: "Ветклиника Лапа",
    openQuestions: 3,
  },
  {
    description: "Кабинет водителя и трекинг рейсов",
    id: "logistic-pro",
    initial: "Л",
    name: "Логистик Про",
    openQuestions: 0,
  },
  {
    description: "Расписание танцевальной школы и абонементы",
    id: "rhythm",
    initial: "Ш",
    name: "Школа Ритм",
    openQuestions: 1,
  },
];

export const USER_NAME = "Дима";
