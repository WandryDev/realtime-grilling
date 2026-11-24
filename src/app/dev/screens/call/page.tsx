import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CallScreen } from "@/features/call/screens/call-screen";
import type { CallScreenState } from "@/features/call/types";

import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";

export const metadata: Metadata = {
  title: "Grill, звонок, окно",
};

// Paper artboards of the call window are 1440 wide, 900 high
const WIDTH = 1440;
const HEIGHT = 900;

const SCREENS: {
  /** Grows with its content instead of the 900px window. */
  auto?: boolean;
  id: string;
  note?: string;
  state: CallScreenState;
  title: string;
}[] = [
  {
    auto: true,
    id: "reference",
    note: "Эталон во всю высоту: слева расшифровка, по центру вопросы по темам, справа найденный контекст. В шапке проект, участники, таймер записи и «Завершить».",
    state: "reference",
    title: "Звонок — основной экран (эталон)",
  },
  {
    id: "starting",
    note: "Первые минуты вопросов нет: агент ждёт, пока станет понятна тема. Входящие из ClickUp уже лежат в «Без темы». Бриф собирается в правой колонке, до готовности агент работает по прошлому брифу от 12 октября.",
    state: "starting",
    title: "02 Начало звонка — бриф загружается",
  },
  {
    id: "question-hover",
    note: "Ховер по вопросу → серая подложка, метка справа меняется на быстрые действия. Подсказка появляется через 500 мс над иконкой, с горячей клавишей.",
    state: "question-hover",
    title: "03 Основной экран — ховер по вопросу",
  },
  {
    id: "question-pinned",
    note: "Закрепить (P) → вопрос поднимается над главным и агент его не двигает, пока не прозвучит ответ.",
    state: "question-pinned",
    title: "03 Основной экран — вопрос закреплён",
  },
  {
    id: "transcript-collapsed",
    note: "«Свернуть» у расшифровки → колонка сжимается в рейку 52 px, панель вопросов забирает место. На рейке видно, кто сейчас говорит. Клик по кнопке сверху разворачивает обратно.",
    state: "transcript-collapsed",
    title: "03 Основной экран — расшифровка свёрнута",
  },
  {
    id: "final-check",
    note: "Агент слышит признаки завершения → сам включает режим. В навигации появляется первая пилюля «Финальная проверка», в списке 3–5 вопросов со всех тем, первый выделен как главный.",
    state: "final-check",
    title: "04 Финальная проверка — включилась сама",
  },
  {
    id: "mic-released",
    note: "Никто, кроме нас, не держит микрофон (это не mute) → в окне звонка снизу появляется панель. Запись продолжается, чёрная кнопка в шапке временно становится серой. Ноль на таймере → звонок завершается сам.",
    state: "mic-released",
    title: "05 Микрофон освободился — в окне",
  },
  {
    id: "agent-timeout",
    note: "Агент молчит дольше 90 с → вопросы замирают и бледнеют, но их можно читать. «Повторить» перезапускает сессию, автоповтор идёт сам по таймеру. Запись не останавливается никогда.",
    state: "agent-timeout",
    title: "07 Ошибки — агент не отвечает",
  },
  {
    id: "limit-reached",
    note: "Кончился лимит подписки → вопросы замирают и бледнеют, но их можно читать. Запись и расшифровка идут.",
    state: "limit-reached",
    title: "07 Ошибки — лимит подписки исчерпан",
  },
  {
    id: "grill-limit",
    note: "Доля сессии дошла до порога Grill (по умолчанию 90 %) → вопросы замирают, остаток лимита остаётся менеджеру. Запись и расшифровка идут. «Продолжить сверх лимита» снимает порог до конца звонка; после сброса окна агент вернётся сам и посмотрит, что сказали за паузу.",
    state: "grill-limit",
    title: "07 Ошибки — лимит Grill",
  },
  {
    id: "transcript-lag",
    note: "Расшифровка отстаёт больше 20 с → плашка вверху колонки, живая реплика скелетоном, в навигации видно, по какой момент актуальны вопросы. Догнали → плашка исчезает сама.",
    state: "transcript-lag",
    title: "07 Ошибки — расшифровка отстаёт",
  },
  {
    id: "no-system-audio",
    note: "Нет системного звука → реплики клиента показаны пунктирными пустыми местами с длительностью, баннер над вопросами.",
    state: "no-system-audio",
    title: "07 Ошибки — нет доступа к системному звуку",
  },
  {
    id: "github-unavailable",
    note: "Недоступная интеграция (GitHub) → только её карточка меняет состояние, вопросы и расшифровка работают как обычно.",
    state: "github-unavailable",
    title: "07 Ошибки — GitHub недоступен",
  },
  {
    id: "finishing",
    note: "«Завершить» или таймер дошёл до нуля → запись останавливается, окно звонка затихает, по центру карточка «Собираю итоги». «Отменить завершение» доступно 10 секунд, «Закрыть окно» не прерывает сборку.",
    state: "finishing",
    title: "08 Звонок завершается — собираю итоги",
  },
];

// Screen catalog for development. Not shipped in the production build.
export default function CallPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow screens={SCREENS} title="Звонок, окно">
      {SCREENS.map((screen) => (
        <ScreenFrame
          height={screen.auto ? "auto" : HEIGHT}
          id={screen.id}
          key={screen.id}
          note={screen.note}
          title={screen.title}
          width={WIDTH}
        >
          <CallScreen
            className={screen.auto ? "w-full" : "size-full"}
            state={screen.state}
          />
        </ScreenFrame>
      ))}
    </ScreenFlow>
  );
}
