import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { LimitOutlook } from "@/bindings";
import { DesktopScene } from "@/features/call-widget/components/desktop-scene";
import { CompactOverlay } from "@/features/call-widget/screens/compact-overlay";
import { MicReleasedWidget } from "@/features/call-widget/screens/mic-released-widget";
import { StartWidget } from "@/features/call-widget/screens/start-widget";
import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";
import { StartNoAccessDemo } from "../_components/widget-demos";

export const metadata: Metadata = {
  title: "Grill, звонок, виджеты",
};

// Paper artboards are 960×600 desktop scenes
const WIDTH = 960;
const HEIGHT = 600;

const SCREENS = [
  { id: "start-prompt", title: "01 Виджет старта — микрофон занят Zoom" },
  { id: "start-project", title: "01 Виджет старта — выбор проекта" },
  { id: "start-launch", title: "01 Виджет старта — запуск" },
  { id: "start-pill", title: "01 Виджет старта — свёрнут в пилюлю" },
  {
    id: "start-no-access",
    title: "01 Виджет старта — нет доступа к микрофону",
  },
  { id: "start-limit-near", title: "01 Виджет старта — лимит почти заполнен" },
  {
    id: "start-limit-reached",
    title: "01 Виджет старта — лимит Grill исчерпан",
  },
  {
    id: "mic-released",
    title: "05 Микрофон освободился — приложение в фоне",
  },
  { id: "overlay", title: "06 Компактный оверлей — обычный режим" },
  {
    id: "overlay-final-check",
    title: "06 Компактный оверлей — финальная проверка",
  },
  { id: "overlay-collapsed", title: "06 Компактный оверлей — свёрнут" },
  {
    id: "overlay-levels",
    title: "06 Компактный оверлей — уровни и канал без доступа",
  },
  { id: "overlay-grill-limit", title: "06 Компактный оверлей — лимит Grill" },
];

const [
  startPrompt,
  startProject,
  startLaunch,
  startPill,
  startNoAccess,
  startLimitNear,
  startLimitReached,
  micReleased,
  overlay,
  overlayFinalCheck,
  overlayCollapsed,
  overlayLevels,
  overlayGrillLimit,
] = SCREENS;

/** 12:00 on the demo's Monday: the session resets at 14:09, the week on 1 December. */
const SESSION_RESET = new Date(2026, 10, 24, 14, 9).getTime();
const WEEK_RESET = new Date(2026, 11, 1, 0, 59).getTime();

const LIMIT_NEAR: LimitOutlook = {
  hit: { resetsAt: SESSION_RESET, threshold: 90, used: 84, window: "session" },
  kind: "near",
};

const LIMIT_REACHED: LimitOutlook = {
  hit: { resetsAt: WEEK_RESET, threshold: 80, used: 81, window: "week" },
  kind: "reached",
};

const GRILL_LIMIT_NOTICE = {
  hint: "сброс в 14:09",
  title: "Лимит Grill: сессия 91 % из 90 %",
};

const LEVELS_WITH_WARNING = {
  level: { me: 0.7, others: 0.35 },
  warning: "Нет доступа к звуку собеседников",
};

// Screen catalog for development. Not shipped in the production build.
export default function CallWidgetsPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow screens={SCREENS} title="Звонок, виджеты">
      <ScreenFrame
        height={HEIGHT}
        id={startPrompt.id}
        note="Zoom, Meet или Telegram занял микрофон → через 2 секунды справа сверху появляется виджет. Проект и участники взяты из прошлого звонка."
        title={startPrompt.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget state="prompt" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startProject.id}
        note="Клик по полю проекта → список с поиском, участники подставляются из профиля проекта. Крестик на чипе убирает человека, плюс добавляет из людей клиента."
        title={startProject.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget state="choosing-project" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startLaunch.id}
        note="«Начать» → запись стартует сразу, бриф освежается параллельно. Виджет можно свернуть или раскрыть в окно звонка или оверлей."
        title={startLaunch.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget state="launching" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startPill.id}
        note="«Не сейчас» или крестик → виджет сворачивается в пилюлю. Она висит, пока микрофон занят, и исчезает вместе со звонком."
        title={startPill.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget state="collapsed" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startNoAccess.id}
        note="«Начать», а доступ к микрофону отозван → запись не начинается, звонок тоже. «Открыть настройки» открывает в главном окне шаг онбординга с доступами."
        title={startNoAccess.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartNoAccessDemo />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startLimitNear.id}
        note="До порога Grill меньше 10 п. п. (тут сессия 84 % из 90 %) → предупреждение над кнопками, «Начать» работает как обычно. Показ виджета запускает внеочередной опрос /usage, плашка обновится через ~5 с."
        title={startLimitNear.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget limit={LIMIT_NEAR} state="prompt" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={startLimitReached.id}
        note="Порог пройден (неделя 81 % из 80 %) → главная кнопка «Начать без агента»: запись и расшифровка идут, вопросов нет. «Начать сверх лимита» начинает звонок так, будто уже выбрали «Продолжить сверх лимита»."
        title={startLimitReached.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:00">
          <StartWidget limit={LIMIT_REACHED} state="prompt" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={micReleased.id}
        note="Никто, кроме нас, не держит микрофон (это не mute), окно звонка в фоне → предложение завершить приходит плавающим виджетом поверх всех окон. Таймер из настроек (5–10 мин, по умолчанию 7); ноль → звонок завершается сам и начинает собирать итоги. «Продолжить» → виджет скрывается до следующего освобождения микрофона."
        title={micReleased.title}
        width={WIDTH}
      >
        <DesktopScene
          className="size-full"
          clock="Пн 12:39"
          meetingEnded
          micInUse={false}
        >
          <MicReleasedWidget />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={overlay.id}
        note="Окно поверх всех окон, 380 px, не попадает в демонстрацию экрана. В фокусе только текущая тема и три верхних вопроса, счётчик «прошлые» показывает незакрытое по другим темам. Стрелки → большое окно звонка, минус → пилюля. Оверлей перетаскивается за шапку и помнит позицию."
        title={overlay.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:24" sharing>
          <CompactOverlay state="default" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={overlayFinalCheck.id}
        note="Финальная проверка включается и здесь: вместо темы заголовок с флажком, у каждого вопроса подпись темы."
        title={overlayFinalCheck.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:38" sharing>
          <CompactOverlay state="final-check" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={overlayCollapsed.id}
        note="В пилюле видны запись, тема и число открытых вопросов. Наведение на число → подсказка «5 открытых вопросов». Новый важный вопрос → под пилюлей на 8 секунд появляется карточка и сама уходит. Клик по карточке разворачивает оверлей, крестик закрывает её сразу."
        title={overlayCollapsed.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:24" sharing>
          <CompactOverlay state="collapsed" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={overlayLevels.id}
        note="Рядом с точкой записи — живой уровень «Я» и «Остальных». Канал без доступа или переподключается → оранжевый треугольник, текст в подсказке и для скринридера."
        title={overlayLevels.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:24" sharing>
          <CompactOverlay recording={LEVELS_WITH_WARNING} state="default" />
        </DesktopScene>
      </ScreenFrame>

      <ScreenFrame
        height={HEIGHT}
        id={overlayGrillLimit.id}
        note="Агент стоит на пороге Grill → под вопросами плашка с окном, долей, порогом и сбросом. «Продолжить сверх лимита» действует до конца этого звонка, итоги и бриф всё равно ждут."
        title={overlayGrillLimit.title}
        width={WIDTH}
      >
        <DesktopScene className="size-full" clock="Пн 12:41" sharing>
          <CompactOverlay
            agentLabel="лимит Grill"
            agentTone="muted"
            limitNotice={GRILL_LIMIT_NOTICE}
            state="default"
          />
        </DesktopScene>
      </ScreenFrame>
    </ScreenFlow>
  );
}
