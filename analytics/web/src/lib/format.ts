// Numbers and names as the pages show them: tabular, short, in Russian.

const ru = new Intl.NumberFormat("ru-RU");

/** `$0.042`, `$1.23`, `$41.80`. */
export const usd = (value: number | null | undefined): string => {
  const amount = value ?? 0;
  if (amount === 0) {
    return "$0";
  }
  return amount < 1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`;
};

/** `640`, `31K`, `4.9M` tokens. */
export const tokens = (value: number | null | undefined): string => {
  const count = value ?? 0;
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}K`;
  }
  return ru.format(count);
};

/** `9.8 с`, `1 мин 12 с`. */
export const seconds = (ms: number): string => {
  const total = ms / 1000;
  if (total < 60) {
    return `${total.toFixed(1)} с`;
  }
  return `${Math.floor(total / 60)} мин ${Math.round(total % 60)} с`;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A time into the call, `12:03` or `1:04:10`. */
export const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "long",
});

/** `19 ноября, 11:02`. */
export const date = (ms: number | null): string =>
  ms === null ? "—" : dateFormat.format(new Date(ms));

/** `1 ч 14 мин`, `38 мин`. */
export const span = (from: number | null, to: number | null): string => {
  if (from === null || to === null) {
    return "—";
  }
  const minutes = Math.round((to - from) / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
    : `${minutes} мин`;
};

export const percent = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)} %`;

export const KIND_NAMES: Record<string, string> = {
  brief: "Бриф проекта",
  fastLoop: "Быстрый контур",
  proposals: "Предложения",
  slowLoop: "Медленный контур",
  summary: "Итоги звонка",
  topicCheck: "Проверка темы",
};

/** The kinds of the call itself, and those of the review after it. */
export const LIVE_KINDS = ["fastLoop", "topicCheck", "slowLoop"];
export const AFTER_KINDS = ["summary", "proposals"];

export const OUTCOME_NAMES: Record<string, string> = {
  cancelled: "отменён",
  empty: "без изменений",
  error: "ошибка",
  invalid: "не по схеме",
  not_logged_in: "нужен вход",
  ok: "применён",
  rate_limited: "лимит",
  timeout: "таймаут",
};

export const TRIGGER_NAMES: Record<string, string> = {
  firstPhrase: "первая фраза клиента",
  haltReset: "после остановки",
  interval: "клиент продолжает говорить",
  manualRetry: "ручной повтор",
  retry: "повтор после ошибки",
  topicChanged: "смена темы",
  turnEnd: "конец реплики клиента",
};

export const STEP_NAMES: Record<string, string> = {
  answered: "отвечен",
  asked: "задан",
  created: "создан",
  evicted: "вытеснена",
  hidden: "скрыт",
  pinned: "закреплён",
  requeued: "ушёл в очередь",
  restored: "возвращён",
  shown: "показан",
  unpinned: "откреплён",
  unshown: "убран с экрана",
};

const REASONS: Record<string, string> = {
  blank: "пустой текст",
  contradictionNeedsTwoSegments: "противоречию нужны две фразы",
  gapWithoutClient: "пробел брифа без слов клиента",
  noCurrentTopic: "нет текущей темы",
  noEvidence: "нет оснований",
  noRoom: "нет места для находки",
  notFromClient: "не слова клиента",
  overLimit: "больше лимита новых вопросов",
  questionClosed: "вопрос уже закрыт",
  quoteNotFound: "цитата не найдена",
  quoteTooShort: "слишком короткая цитата",
  repeat: "повтор",
  stale: "устарело за время вызова",
  storage: "ошибка хранилища",
  topicInFinalCheck: "новая тема в финальной проверке",
  topicRejected: "отклонена тема операции",
  unknownCardField: "нет такого поля карточки",
  unknownPhrase: "нет такой фразы",
  unknownQuestion: "нет такого вопроса",
  unknownSource: "неизвестный источник",
  unknownTopic: "нет такой темы",
};

/** A rejection as a person would say it, with its quote when it has one. */
export const reasonText = (reason: unknown): string => {
  if (typeof reason !== "object" || reason === null) {
    return "отклонена";
  }
  const fields = reason as Record<string, unknown>;
  const tag = String(fields.reason ?? "");
  const name = REASONS[tag] ?? tag;
  if (typeof fields.quote === "string") {
    return `${name}: «${fields.quote}»`;
  }
  if (tag === "repeat" && typeof fields.score === "number") {
    return `${name}, сходство ${fields.score.toFixed(2)}`;
  }
  return name;
};

/** `1 часть`, `2 части`, `5 частей`: the Russian form for `count`. */
export const plural = (
  count: number,
  [one, few, many]: readonly [string, string, string]
): string => {
  const tens = count % 100;
  const units = count % 10;
  let word = many;
  if (tens < 11 || tens > 14) {
    if (units === 1) {
      word = one;
    } else if (units >= 2 && units <= 4) {
      word = few;
    }
  }
  return `${ru.format(count)} ${word}`;
};

/** An operation of the agent's patch. */
export const OP_NAMES: Record<string, string> = {
  answered: "Ответ на вопрос",
  card: "Факт карточки",
  finalCheck: "Финальная проверка",
  finding: "Находка",
  new: "Новая тема",
  question: "Вопрос",
  same: "Тема та же",
  switch: "Смена темы",
  topic: "Тема",
};

/** A lens of the topic's card. */
export const LENS_NAMES: Record<string, string> = {
  acceptance: "Критерии готовности",
  constraints: "Ограничения",
  edgeCases: "Крайние случаи",
  goal: "Цель",
  integrations: "Интеграции",
  scenarios: "Сценарии",
  users: "Пользователи",
};

export const GAP_NAMES: Record<string, string> = {
  assumption: "допущение",
  contradiction: "противоречие",
  empty: "пробел",
};
