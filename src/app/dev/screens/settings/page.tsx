import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AgentSettingsScreen } from "@/features/settings/screens/agent-settings";
import { AudioSettingsScreen } from "@/features/settings/screens/audio-settings";
import { GeneralSettingsScreen } from "@/features/settings/screens/general-settings";
import { IntegrationsSettingsScreen } from "@/features/settings/screens/integrations-settings";
import { PrivacySettingsScreen } from "@/features/settings/screens/privacy-settings";
import { WidgetSettingsScreen } from "@/features/settings/screens/widget-settings";

import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";

export const metadata: Metadata = {
  title: "Grill, настройки",
};

// Paper artboards are 1440 wide main windows
const WIDTH = 1440;
const HEIGHT = 900;

interface SettingsFrame {
  /** Artboard height; "auto" for the expanded scroll. */
  height: number | "auto";
  id: string;
  note: string;
  render: (className: string) => ReactNode;
  title: string;
}

const FRAMES: SettingsFrame[] = [
  {
    height: HEIGHT,
    id: "general",
    note: "Вход из пункта «Настройки» внизу боковой панели: она превращается в список разделов, «К проектам» возвращает на главную. Всё сохраняется сразу, кнопки «Сохранить» нет. Папка записей, занятое место и число звонков с аудио приходят из Rust (`recordings_info`); «Показать в Finder» (на Windows «Показать в проводнике») открывает её. «Тема» применяется сразу во всех окнах, «Как в системе» следует за системой. Строка «Открывать при входе в систему» кликается целиком.",
    render: (className) => <GeneralSettingsScreen className={className} />,
    title: "16 Настройки — общие",
  },
  {
    height: HEIGHT,
    id: "audio",
    note: "Микрофоны — устройства ввода компьютера и «Как в системе», список обновляется сам. Полоски уровня живые, пока открыт раздел: оранжевая, когда сигнал есть, серая на тишине, вместо уровня — причина («нет доступа», «нет устройства», «занято»). Системный звук берётся со всей системы без звука Grill, под полоской — есть ли доступ. «Проверить звук» записывает несколько секунд с выбранного микрофона и показывает распознанный текст. Модель выбирается радио, «Скачать» показывает прогресс прямо в строке. Во время звонка выбор устройств и модели неактивен.",
    render: (className) => <AudioSettingsScreen className={className} />,
    title: "17 Настройки — звук и распознавание",
  },
  {
    height: HEIGHT,
    id: "agent",
    note: "Статус спрашивается у Claude Code при открытии раздела и по «Проверить снова». Путь без сохранённого — «найден автоматически»; «Указать другой» сначала проверяет CLI по пути. Без входа — «нужен вход» и «Войти» тем же потоком, что в онбординге. Лимит — последняя доля из вызовов агента со временем замера, от 90 % полоска красная, без замеров «нет данных». Изменения частоты и количества вопросов применяются к следующему звонку.",
    render: (className) => <AgentSettingsScreen className={className} />,
    title: "18 Настройки — агент",
  },
  {
    height: "auto",
    id: "widget",
    note: "Состояние записи сочетания: клик по полю «Показать или скрыть оверлей» → поле в фокусе, нажатые модификаторы появляются сразу, курсор ждёт основную клавишу. Esc отменяет запись, Backspace на пустом поле удаляет сочетание. «Сбросить все» возвращает сочетания по умолчанию сразу, с тостом «Вернуть». Высота по контенту, это развёрнутый скролл.",
    render: (className) => (
      <WidgetSettingsScreen className={className} recording="toggle-overlay" />
    ),
    title: "19 Настройки — виджет и клавиши, запись сочетания",
  },
  {
    height: HEIGHT,
    id: "privacy",
    note: "Блок «Что уходит с компьютера» без действий: он объясняет, а не настраивает. Аудио: 7, 30, 90 дней или «Не удалять»; расшифровки: через 3 или 6 месяцев, через год или «Не удалять» — сроки исполняет Rust. Сводка у «Очистить всё» настоящая (`data_summary`), диалог подтверждается вводом слова «удалить», во время звонка удаление отказывает.",
    render: (className) => <PrivacySettingsScreen className={className} />,
    title: "20 Настройки — приватность и хранение",
  },
  {
    height: HEIGHT,
    id: "audio-mic-disabled",
    note: "Выбранный микрофон пропал из системы. Пока его нет, Grill слушает микрофон по умолчанию, а плашка говорит, с какого времени его нет. Вернулся — плашка исчезает и Grill снова слушает его. «Взять микрофон по умолчанию» выбирает «Как в системе».",
    render: (className) => (
      <AudioSettingsScreen className={className} microphone="disabled" />
    ),
    title: "21 Настройки — звук, микрофон отключён",
  },
  {
    height: HEIGHT,
    id: "integrations",
    note: "Все состояния сразу: GitHub подключён, Outline сломан, ClickUp работает только на чтение. Красная точка у «Интеграции» появляется, когда хоть один сервис не работает. «Обновить ключ» открывает экран ключа с заполненным адресом. Claude Code здесь только для справки: документы и задачи Grill загружает сам и передаёт агенту текст.",
    render: (className) => <IntegrationsSettingsScreen className={className} />,
    title: "07 Настройки, Интеграции — разные состояния",
  },
  {
    height: HEIGHT,
    id: "integrations-disconnect",
    note: "«Отключить» у любого сервиса → диалог подтверждения с последствиями для проектов.",
    render: (className) => (
      <IntegrationsSettingsScreen
        className={className}
        state="confirm-disconnect"
      />
    ),
    title: "07 Настройки, Интеграции — отключить GitHub",
  },
  {
    height: HEIGHT,
    id: "integrations-github-off",
    note: "После отключения тост «Вернуть» живёт 8 секунд: токен ещё не удалён и подключение восстанавливается без нового входа. Не подключённый сервис: серый статус и пилюля «Подключить», ведёт на тот же подэкран, что в онбординге.",
    render: (className) => (
      <IntegrationsSettingsScreen
        className={className}
        state="github-disconnected"
      />
    ),
    title: "07 Настройки, Интеграции — GitHub не подключён",
  },
  {
    height: HEIGHT,
    id: "integrations-app-empty",
    note: "В приложении ничего не подключено: у Outline и ClickUp «Подключить», GitHub «скоро». «Подключить» у ClickUp открывает диалог токена: поле с маской, ссылка «Открыть страницу токена» на app.clickup.com/settings/apps, ошибка у поля («Токен не подошёл»), фокус остаётся в поле. Если токен открывает несколько рабочих пространств, в диалоге появляется радиогруппа, «Подключить» отправляет тот же токен с выбранным пространством. Пока пространство не выбрано, ничего не сохраняется.",
    render: (className) => (
      <IntegrationsSettingsScreen className={className} state="app-empty" />
    ),
    title: "07 Настройки, Интеграции — ничего не подключено",
  },
  {
    height: HEIGHT,
    id: "integrations-clickup-revoked",
    note: "Токен ClickUp удалили в ClickUp: строка в ошибке с «Обновить токен», задачи в проектах остаются с последним текстом. Подключённый ClickUp показывает пространство и чей токен.",
    render: (className) => (
      <IntegrationsSettingsScreen
        className={className}
        state="clickup-revoked"
      />
    ),
    title: "07 Настройки, Интеграции — токен ClickUp отозван",
  },
];

const SCREENS = FRAMES.map(({ id, title }) => ({ id, title }));

// Screen catalog for development. Not shipped in the production build.
export default function SettingsScreensPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow screens={SCREENS} title="Настройки">
      {FRAMES.map((frame) => (
        <ScreenFrame
          height={frame.height}
          id={frame.id}
          key={frame.id}
          note={frame.note}
          title={frame.title}
          width={WIDTH}
        >
          {frame.render(frame.height === "auto" ? "w-full" : "size-full")}
        </ScreenFrame>
      ))}
    </ScreenFlow>
  );
}
