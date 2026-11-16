import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesktopScene } from "@/features/call-widget/components/desktop-scene";
import { CompactOverlay } from "@/features/call-widget/screens/compact-overlay";
import { MicReleasedWidget } from "@/features/call-widget/screens/mic-released-widget";
import { StartWidget } from "@/features/call-widget/screens/start-widget";
import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";

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
];

const [
  startPrompt,
  startProject,
  startLaunch,
  startPill,
  startNoAccess,
  micReleased,
  overlay,
  overlayFinalCheck,
  overlayCollapsed,
  overlayLevels,
] = SCREENS;

const NO_ACCESS_ERROR = {
  description:
    "Разрешите Grill доступ к микрофону в системных настройках и нажмите «Начать» ещё раз.",
  onOpenSettings: () => undefined,
  title: "Нет доступа к микрофону",
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
          <StartWidget startError={NO_ACCESS_ERROR} state="prompt" />
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
    </ScreenFlow>
  );
}
