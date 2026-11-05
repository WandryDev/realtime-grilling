import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CallDetailsScreen } from "@/features/post-call/screens/call-details-screen";
import { CallHistoryScreen } from "@/features/post-call/screens/call-history-screen";
import { CallSummaryScreen } from "@/features/post-call/screens/call-summary-screen";
import { ProposalsReviewScreen } from "@/features/post-call/screens/proposals-review-screen";
import { TaskCardsScreen } from "@/features/post-call/screens/task-cards-screen";
import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";

export const metadata: Metadata = {
  title: "Grill, после звонка",
};

const WIDTH = 1440;
const HEIGHT = 900;

/* Designer notes from Paper ("Заметка — 01…07"), verbatim. */
const NOTES = {
  details: [
    "Полная расшифровка по двум каналам: «Вы» справа чёрным, «Клиент» слева белым. Пилюли тем — якоря, активная тема чёрная и меняется при прокрутке.",
    "Плеер закреплён внизу: пробел — пауза, клик по волне — перемотка, скорость 1×, 1,5×, 2×, можно слушать один канал. Играющая реплика синхронно подсвечивается.",
    "Клик по вопросу справа (или по таймкоду в итогах и карточках) → расшифровка плавно прокручивается, момент подсвечивается светло-оранжевым на 4 секунды, плеер встаёт на это время.",
    "«Удалить запись» в карточке справа → диалог подтверждения (07).",
  ].join(" "),
  history: [
    "Проект в сайдбаре → список его звонков по месяцам. «Все звонки» → тот же список по всем проектам, пилюли сверху фильтруют по проекту.",
    "В строке: дата и время, темы, участники, счётчик открытых вопросов и длительность. Оранжевая плашка «4 предложения» есть, пока ревью не закончено.",
    "Ховер подсвечивает строку серым, клик открывает итоги звонка (02).",
    "Поиск (⌘K) ищет по расшифровкам и итогам локально. В результате видна найденная фраза, клик по ней открывает 06 сразу на этом месте.",
    "Новый проект без звонков: пустое состояние с проверкой готовности. «Начать звонок» в шапке — главное действие.",
  ].join(" "),
  processing: [
    "Звонок завершился (вручную или по тайм-ауту) → окно сразу открывает «Сборку итогов». Шаги идут сверху вниз, полоска показывает прогресс текущего шага.",
    "Пока шаг не готов, пункт в левой навигации серый и не кликается. «Расшифровка» доступна сразу.",
    "Окно можно закрыть: агент дособерёт итоги в фоне. Когда всё готово, появляется тост «Итоги сохранены». Тост висит 5 секунд, «Открыть историю» ведёт в список звонков проекта.",
    "Ничего не уходит в Outline или ClickUp: итоги и аудио Opus лежат только на этом компьютере.",
  ].join(" "),
  proposals: [
    "Ничего не применяется само. Каждое предложение: было (зачёркнуто) и станет (на светлом оранжевом), источник справа сверху.",
    "«Принять» → карточка сворачивается в серую строку с галочкой и «Отменить». Отмена возвращает её в ожидание.",
    "«Изменить» → новый текст становится полем ввода в фокусе. «Сохранить и принять» (⌘ Enter) применяет вашу версию, Esc отменяет правку.",
    "«Отклонить» → строка с пунктирной рамкой и «Вернуть». Отклонённое агент больше не предлагает.",
    "Счётчик в навигации и полоска сверху показывают, сколько осталось. Клавиши: A, E, X, J/K.",
    "Когда решений не осталось → состояние «Всё разобрано».",
  ].join(" "),
  removal: [
    "Плеер ставится на паузу, окно затемняется. Диалог прямо говорит, что удалится (только аудио) и что останется (расшифровка, итоги, карточки, принятые изменения).",
    "Фокус по умолчанию на «Отмена», Esc закрывает. «Удалить запись» → плеер исчезает, в истории у звонка появляется пометка «аудио удалено», тост «Запись удалена».",
    "Таймкоды и подсветка моментов в расшифровке продолжают работать, просто без звука.",
  ].join(" "),
  summary: [
    "Клик по таймкоду пункта → «Детали звонка», расшифровка прокручивается к этому моменту и подсвечивает его (см. 06).",
    "Цветная точка у пункта повторяет статус из карточки задачи: синяя — допущение, красная — противоречие.",
    "«Не успели спросить» — открытые и заданные без ответа вопросы звонка; в следующий звонок они пока не переносятся. Ховер по строке показывает «Убрать», если вопрос больше не нужен.",
    "«Ответы для ClickUp»: только чтение, в ClickUp ничего не пишем. Клик по CU-517 открывает задачу в браузере, ховер по ответу показывает «Скопировать».",
    "«Разобрать предложения» — единственная главная кнопка экрана, ведёт в 04.",
  ].join(" "),
  tasks: [
    "Пилюли тем сверху — якоря: клик прокручивает к карточке темы. У каждой карточки 7 полей, пустые не прячем, а показываем статусом «пусто».",
    "У каждого пункта статус справа и источник под текстом: «сказал клиент», «из доков» (Outline), «из кода» (GitHub) или «допущение агента» (логотип Claude).",
    "Клик по источнику раскрывает пункт: показывается реплика из расшифровки, из которой он взят, с таймкодом. «Послушать» играет фрагмент, «Открыть в расшифровке» ведёт в 06 с подсветкой. Повторный клик сворачивает.",
    "Справа — вопросы, которые агент сам вывел из пустых полей, допущений и противоречий, чтобы задать их в следующий раз.",
  ].join(" "),
};

const SCREENS = [
  { id: "summary-processing", title: "01 Сборка итогов — идёт обработка" },
  { id: "summary-toast", title: "07 Мини-флоу — тост «Итоги сохранены»" },
  { id: "summary-ready", title: "02 Итоги звонка — готово" },
  { id: "task-cards", title: "03 Карточки задач — раскрыт источник" },
  {
    id: "proposals-partial",
    title: "04 Ревью предложений — частично разобрано",
  },
  { id: "proposals-done", title: "04 Ревью предложений — всё разобрано" },
  { id: "history-project", title: "05 История звонков — проект" },
  { id: "history-search", title: "05 История звонков — все проекты, поиск" },
  { id: "history-empty", title: "05 История звонков — новый проект, пусто" },
  { id: "details", title: "06 Детали звонка — расшифровка и плеер" },
  {
    id: "details-moment",
    title: "06 Детали звонка — переход к моменту вопроса",
  },
  { id: "details-delete", title: "07 Мини-флоу — удаление записи звонка" },
];

function titleOf(id: string) {
  return SCREENS.find((screen) => screen.id === id)?.title ?? id;
}

// After-call flow from Paper ("После звонка"). Not shipped in production.
export default function PostCallScreensPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow screens={SCREENS} title="После звонка">
      <ScreenFrame
        height={HEIGHT}
        id="summary-processing"
        note={NOTES.processing}
        title={titleOf("summary-processing")}
        width={WIDTH}
      >
        <CallSummaryScreen className="size-full" state="processing" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="summary-toast"
        note={NOTES.processing}
        title={titleOf("summary-toast")}
        width={WIDTH}
      >
        <CallSummaryScreen className="size-full" toast />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="summary-ready"
        note={NOTES.summary}
        title={titleOf("summary-ready")}
        width={WIDTH}
      >
        <CallSummaryScreen className="w-full" />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="task-cards"
        note={NOTES.tasks}
        title={titleOf("task-cards")}
        width={WIDTH}
      >
        <TaskCardsScreen className="w-full" />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="proposals-partial"
        note={NOTES.proposals}
        title={titleOf("proposals-partial")}
        width={WIDTH}
      >
        <ProposalsReviewScreen className="w-full" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="proposals-done"
        title={titleOf("proposals-done")}
        width={WIDTH}
      >
        <ProposalsReviewScreen className="size-full" state="done" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="history-project"
        note={NOTES.history}
        title={titleOf("history-project")}
        width={WIDTH}
      >
        <CallHistoryScreen className="size-full" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="history-search"
        title={titleOf("history-search")}
        width={WIDTH}
      >
        <CallHistoryScreen className="size-full" query="amoCRM" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="history-empty"
        title={titleOf("history-empty")}
        width={WIDTH}
      >
        <CallHistoryScreen className="size-full" projectId="rhythm" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="details"
        note={NOTES.details}
        title={titleOf("details")}
        width={WIDTH}
      >
        <CallDetailsScreen className="size-full" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="details-moment"
        title={titleOf("details-moment")}
        width={WIDTH}
      >
        <CallDetailsScreen className="size-full" momentId="phone" />
      </ScreenFrame>
      <ScreenFrame
        height={HEIGHT}
        id="details-delete"
        note={NOTES.removal}
        title={titleOf("details-delete")}
        width={WIDTH}
      >
        <CallDetailsScreen className="size-full" dialog="delete-recording" />
      </ScreenFrame>
    </ScreenFlow>
  );
}
