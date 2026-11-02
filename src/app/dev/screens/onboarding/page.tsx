import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  AgentScreen,
  type AgentState,
} from "@/features/onboarding/screens/agent-screen";
import {
  PermissionsScreen,
  type PermissionsState,
} from "@/features/onboarding/screens/permissions-screen";
import {
  SpeechModelScreen,
  type SpeechModelState,
} from "@/features/onboarding/screens/speech-model-screen";
import { WelcomeScreen } from "@/features/onboarding/screens/welcome-screen";
import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";
import {
  ONBOARDING_INTEGRATION_SCREENS,
  OnboardingIntegrationFrames,
} from "./_integrations";

export const metadata: Metadata = {
  title: "Grill, онбординг",
};

const WIDTH = 1080;
const HEIGHT = 720;

/* Designer notes from Paper ("Заметка — 01…04"), verbatim. */
const NOTES = {
  agent: [
    "При входе на шаг ищем Claude Code в PATH и стандартных папках, проверяем версию и вход. Обычно это 1–2 секунды, состояние «Проверка».",
    "Найден и вход выполнен → все три строки зелёные, «Продолжить» активна. Переход дальше не автоматический, человек должен увидеть, что всё в порядке.",
    "Нужен вход: «Войти» запускает вход Claude Code, браузер открывается сам. После входа страница Claude показывает код: его вставляют в поле «Код из браузера» и жмут «Подтвердить», затем проверяем подписку. «Открыть страницу ещё раз», если браузер закрыли; «Отменить» возвращает к «Войти».",
    "Неверный код: ошибка под полем, сеанс входа закрыт, «Войти ещё раз» начинает новый. Вход истёк (10 минут) или его отменили: снова «Нужен вход» с подсказкой. Grill код не сохраняет.",
    "Вошли в терминале: при возврате фокуса в окно Grill перечитывает статус и показывает «Вход выполнен».",
    "Не установлен: «Установить» скачивает и ставит агента без терминала и пароля, шаги 1–3 идут по очереди с прогрессом, «Отменить» останавливает установщик. «Проверить снова», если человек поставил его сам.",
    "Ошибка установки: причина одной строкой и лог установщика моноширинным текстом, «Скопировать для поддержки» кладёт в буфер лог и версию ОС. «Повторить» запускает установку заново.",
    "Claude Code не отвечает (проверка дольше 10 секунд или не начался вход): та же карточка ошибки с «Проверить снова».",
    "Без агента дальше не пускаем: это единственный обязательный шаг после разрешений и модели.",
  ].join(" "),
  permissions: [
    "Клик «Разрешить» у микрофона → системный диалог macOS поверх окна. Статус в строке «Ждём ответа» со спиннером, «Продолжить» неактивна.",
    "«Разрешить» в диалоге → строка становится «Разрешено», переходим к записи экрана. Её macOS не спрашивает диалогом: сразу открываем «Конфиденциальность и безопасность».",
    "«Не разрешать» или выключенный тумблер → состояние «Отказано»: инструкция в три шага и кнопка «Открыть настройки». После включения тумблера macOS перезапускает Grill, открываем мастер на этом же шаге.",
    "«Проверить» → перечитываем статус без перезапуска. Пока любой доступ не выдан, дальше не пускаем: без системного звука Grill не слышит клиента.",
    "Windows: спрашивается только микрофон, системный звук берём через loopback. Полоска уровня оживает, когда в системе что-то играет.",
  ].join(" "),
  speech: [
    "Язык по умолчанию берём из системы. Выбор языка → сразу начинаем скачивать модель, примерно 1,5 ГБ. Сменить язык во время скачивания можно, текущая загрузка отменится.",
    "«Пауза» → кнопка меняется на «Продолжить», загрузка докачивается с того же места, в том числе после перезапуска. «Отменить» → удаляем недокачанный файл, возвращаемся к выбору языка.",
    "«Продолжить» внизу активна сразу: модель докачивается в фоне, а прогресс виден на шаге «Готово» и в сайдбаре.",
    "Перед загрузкой проверяем свободное место. Не хватает → «Нет места», показываем сколько освободить, «Повторить» перепроверяет диск.",
    "Обрыв сети → «Нет сети», три автоповтора с паузой, потом ручной «Повторить». Скачанное не теряется.",
    "После загрузки сверяем контрольную сумму («Проверка»). Не сошлась → качаем заново молча, один раз.",
  ].join(" "),
  welcome: [
    "Показывается один раз, при первом запуске. Повторно мастер не открывается: всё, что пропустили, настраивается в разделе «Настройки».",
    "Шаги в шапке не кликабельны вперёд, назад можно вернуться на любой пройденный.",
    "Закрыли окно посреди мастера → при следующем запуске продолжаем с того же шага.",
  ].join(" "),
};

interface Frame {
  id: string;
  note?: string;
  render: (className: string) => ReactNode;
  title: string;
}

const PERMISSION_FRAMES: [string, string, PermissionsState][] = [
  ["permissions-idle", "02 Разрешения — не запрошены", "idle"],
  ["permissions-prompt", "02 Разрешения — запрос macOS", "prompt"],
  ["permissions-granted", "02 Разрешения — выданы", "granted"],
  ["permissions-denied", "02 Разрешения — отказано", "denied"],
  [
    "permissions-unknown",
    "02 Разрешения — системный звук не узнать",
    "unknown",
  ],
  ["permissions-windows", "02 Разрешения — Windows", "windows"],
];

const SPEECH_FRAMES: [string, string, SpeechModelState][] = [
  ["speech-language", "03 Модель речи — выбор языка", "language"],
  ["speech-downloading", "03 Модель речи — скачивание", "downloading"],
  ["speech-checking", "03 Модель речи — проверка", "checking"],
  ["speech-ready", "03 Модель речи — готово", "ready"],
  ["speech-no-space", "03 Модель речи — ошибка, нет места", "no-space"],
  ["speech-no-network", "03 Модель речи — ошибка, нет сети", "no-network"],
];

const AGENT_FRAMES: [string, string, AgentState][] = [
  ["agent-checking", "04 Агент — проверка", "checking"],
  ["agent-ready", "04 Агент — найден, вход выполнен", "ready"],
  ["agent-needs-login", "04 Агент — установлен, нужен вход", "needs-login"],
  ["agent-awaiting-code", "04 Агент — вход начат, ждём код", "awaiting-code"],
  ["agent-not-installed", "04 Агент — не установлен", "not-installed"],
  ["agent-installing", "04 Агент — установка", "installing"],
  ["agent-install-error", "04 Агент — ошибка установки", "install-error"],
  ["agent-error", "04 Агент — не отвечает", "error"],
];

const FRAMES: Frame[] = [
  {
    id: "welcome",
    note: NOTES.welcome,
    render: (className) => <WelcomeScreen className={className} />,
    title: "01 Приветствие — старт",
  },
  ...PERMISSION_FRAMES.map(
    ([id, title, state], index): Frame => ({
      id,
      note: index === 0 ? NOTES.permissions : undefined,
      render: (className) => (
        <PermissionsScreen className={className} state={state} />
      ),
      title,
    })
  ),
  {
    id: "permissions-silent",
    render: (className) => (
      <PermissionsScreen
        className={className}
        silentSystemAudio
        state="unknown"
      />
    ),
    title: "02 Разрешения — тишина, хотя звук играет",
  },
  {
    id: "permissions-no-microphone",
    render: (className) => (
      <PermissionsScreen
        className={className}
        microphoneLevel={{ active: 0, levels: [], problem: "noDevice" }}
        state="granted"
      />
    ),
    title: "02 Разрешения — нет микрофона",
  },
  ...SPEECH_FRAMES.map(
    ([id, title, state], index): Frame => ({
      id,
      note: index === 0 ? NOTES.speech : undefined,
      render: (className) => (
        <SpeechModelScreen className={className} state={state} />
      ),
      title,
    })
  ),
  ...AGENT_FRAMES.map(
    ([id, title, state], index): Frame => ({
      id,
      note: index === 0 ? NOTES.agent : undefined,
      render: (className) => (
        <AgentScreen className={className} state={state} />
      ),
      title,
    })
  ),
  {
    id: "agent-code-rejected",
    render: (className) => (
      <AgentScreen
        className={className}
        loginError="Код не подошёл, попробуйте войти ещё раз"
        state="awaiting-code"
      />
    ),
    title: "04 Агент — код не подошёл",
  },
];

// Onboarding screens for development. Not shipped in the production build.
export default function OnboardingScreensPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow
      screens={[
        ...FRAMES.map(({ id, title }) => ({ id, title })),
        ...ONBOARDING_INTEGRATION_SCREENS,
      ]}
      title="Онбординг"
    >
      {FRAMES.map((frame) => (
        <ScreenFrame
          height={HEIGHT}
          id={frame.id}
          key={frame.id}
          note={frame.note}
          title={frame.title}
          width={WIDTH}
        >
          {frame.render("size-full")}
        </ScreenFrame>
      ))}
      <OnboardingIntegrationFrames />
    </ScreenFlow>
  );
}
