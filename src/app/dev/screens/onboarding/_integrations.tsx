import type { ReactNode } from "react";

import {
  ClickUpConnectScreen,
  type ClickUpConnectState,
} from "@/features/onboarding/screens/clickup-connect-screen";
import { DoneScreen } from "@/features/onboarding/screens/done-screen";
import {
  GitHubConnectScreen,
  type GitHubConnectState,
} from "@/features/onboarding/screens/github-connect-screen";
import {
  IntegrationsScreen,
  type IntegrationsScreenState,
} from "@/features/onboarding/screens/integrations-screen";
import {
  OutlineConnectScreen,
  type OutlineConnectState,
} from "@/features/onboarding/screens/outline-connect-screen";
import { ScreenFrame } from "../_components/screen-frame";

/*
 * Onboarding 05–06: integrations, the GitHub, Outline and ClickUp steps and
 * the summary. Rendered by page.tsx after steps 01–04.
 */

const WIDTH = 1080;
const HEIGHT = 720;

/* Designer notes from Paper ("Заметка — 05…06"), on the first frame of a step. */
const NOTES = {
  clickup:
    "Вход по личному токену, без OAuth. «Открыть страницу токена» ведёт в ClickUp: Settings → Apps, раздел API Token. Токен после вставки маскируем: видны начало и последние 4 символа, глаз показывает целиком. «Подключить» → «Проверка токена»: запросы /user и /team, поле блокируется. Токен не подошёл (401) → «Токен не подошёл» у поля, фокус остаётся в нём, ClickUp не подключён. ClickUp не ответил за 15 секунд → сообщение у поля, токен не стираем. Токен открывает несколько рабочих пространств → радиогруппа пространств и «Подключить»: до выбора ничего не сохраняем. Успех → «Подключено»: пространство, чей токен и пространства, которые видит Grill. Токен лежит в Keychain, Grill только читает задачи и комментарии.",
  done: "Итог по всем шагам. Обязательное (разрешения, модель, агент) всегда с галочкой, иначе сюда не попасть. Пропущенные интеграции серые, с текстовой «Подключить». «Подключить» у пропущенного сервиса → его подэкран, после него возвращаемся сюда, а не к списку интеграций. Модель ещё докачивается → в строке «Распознавание речи» прогресс в процентах. Кнопка всё равно активна, первый звонок дождётся модели. «Добавить первый проект» закрывает мастер и открывает главное окно сразу на мастере нового проекта (страница «Проекты и настройки», 03).",
  github:
    "При открытии экрана запрашиваем у GitHub код устройства и сразу кладём его в буфер обмена. «Скопировать» нужна на случай, если буфер перезаписали. «Открыть github.com/login/device» → страница в браузере по умолчанию, экран переходит в «Ждём подтверждения». Grill опрашивает GitHub раз в 5 секунд, пароль и токен руками не вводятся. Таймер «действует ещё 14:52» идёт от 15:00. Последнюю минуту цифры становятся красными. Authorize на GitHub → «Подключено»: аккаунт, число доступных репозиториев, первые три. Сами дальше не переходим, ждём клик «Готово» → возврат к списку интеграций. Прошло 15 минут или на GitHub нажали Cancel → «Код истёк», цифры гаснут. «Получить новый код» запрашивает новый и снова копирует его. Доступ только на чтение. Какие репозитории смотреть, выбирается потом в каждом проекте.",
  integrations:
    "Все три сервиса необязательные. «Продолжить» активна с самого начала, даже если ничего не подключено. Отдельной кнопки «Пропустить» нет. Клик по строке или «Подключить» → подэкран сервиса (05a, 05b, 05c). После успеха или «Назад» возвращаемся сюда, строка показывает новый статус. Статусы в строке: «Подключить» серой пилюлей, «Ждём браузер» со спиннером, «Подключено» зелёным, «Исправить» на мягком красном. «Исправить» открывает подэкран с сохранённым адресом. Ушли дальше с ошибкой у сервиса → на шаге «Готово» он показан как пропущенный, ошибку не тащим дальше.",
  outline:
    "Адрес принимаем в любом виде: без https, со слешем в конце, со ссылкой на конкретный документ. Сами обрезаем до корня. «Открыть страницу ключей» ведёт на адрес/settings/api-and-apps введённого Outline. Пока адрес пустой, ссылка неактивна. Ключ после вставки маскируем, видны начало и последние 4 символа. Глаз справа показывает ключ целиком. «Подключить» → «Проверка ключа»: один запрос к auth.info, поля блокируются. Обычно меньше секунды. Ответ 401 → «Ключ не подошёл», красная рамка у поля, фокус остаётся в нём. Адрес не отвечает → ошибка под полем адреса, ключ не трогаем. Успех → «Подключено»: имя команды и список коллекций. Ключ хранится в системной связке ключей, не в файлах Grill.",
} as const;

interface Frame {
  id: string;
  note?: string;
  render: (className: string) => ReactNode;
  title: string;
}

/** One frame per state; the step's note goes on its first frame. */
function framesOf<State>(
  rows: [string, string, State][],
  note: string,
  render: (state: State, className: string) => ReactNode
): Frame[] {
  return rows.map(([id, title, state], index) => ({
    id,
    note: index === 0 ? note : undefined,
    render: (className) => render(state, className),
    title,
  }));
}

const FRAMES: Frame[] = [
  ...framesOf<IntegrationsScreenState>(
    [
      ["integrations-empty", "05 Интеграции — ничего не подключено", "empty"],
      [
        "integrations-partial",
        "05 Интеграции — частично подключено",
        "partial",
      ],
    ],
    NOTES.integrations,
    (state, className) => (
      <IntegrationsScreen className={className} state={state} />
    )
  ),
  ...framesOf<GitHubConnectState>(
    [
      ["github-code", "05a GitHub — код устройства", "code"],
      ["github-waiting", "05a GitHub — ждём подтверждения", "waiting"],
      ["github-connected", "05a GitHub — подключено", "connected"],
      ["github-expired", "05a GitHub — код истёк", "expired"],
    ],
    NOTES.github,
    (state, className) => (
      <GitHubConnectScreen className={className} state={state} />
    )
  ),
  ...framesOf<OutlineConnectState>(
    [
      ["outline-form", "05b Outline — адрес и ключ", "form"],
      ["outline-checking", "05b Outline — проверка ключа", "checking"],
      ["outline-rejected", "05b Outline — ключ не подошёл", "rejected"],
      ["outline-connected", "05b Outline — подключено", "connected"],
    ],
    NOTES.outline,
    (state, className) => (
      <OutlineConnectScreen className={className} state={state} />
    )
  ),
  ...framesOf<ClickUpConnectState>(
    [
      ["clickup-form", "05c ClickUp — токен", "form"],
      ["clickup-checking", "05c ClickUp — проверка токена", "checking"],
      ["clickup-rejected", "05c ClickUp — токен не подошёл", "rejected"],
      ["clickup-choose", "05c ClickUp — выбор пространства", "choose"],
      ["clickup-connected", "05c ClickUp — подключено", "connected"],
    ],
    NOTES.clickup,
    (state, className) => (
      <ClickUpConnectScreen className={className} state={state} />
    )
  ),
  {
    id: "done",
    note: NOTES.done,
    render: (className) => <DoneScreen className={className} />,
    title: "06 Готово — итог настройки",
  },
];

export const ONBOARDING_INTEGRATION_SCREENS: { id: string; title: string }[] =
  FRAMES.map(({ id, title }) => ({ id, title }));

export function OnboardingIntegrationFrames() {
  return (
    <>
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
    </>
  );
}
