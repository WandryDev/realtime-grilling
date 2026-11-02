import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HomeScreen } from "@/features/projects/screens/home-screen";
import { NewProjectScreen } from "@/features/projects/screens/new-project-screen";
import { PersonScreen } from "@/features/projects/screens/person-screen";
import { ProjectScreen } from "@/features/projects/screens/project-screen";

import { ScreenFlow, ScreenFrame } from "../_components/screen-frame";

export const metadata: Metadata = {
  title: "Grill, проекты",
};

const SCREENS = [
  { id: "home", title: "01 Главная" },
  { id: "first-run", title: "02 Первый запуск" },
  { id: "new-name", title: "03 Шаг 1" },
  { id: "new-name-error", title: "04 Ошибка" },
  { id: "new-sources", title: "05 Источники" },
  { id: "new-people", title: "06 Люди" },
  { id: "new-notes", title: "07 Заметки" },
  { id: "new-building", title: "08 Собираю бриф" },
  { id: "new-ready", title: "09 Бриф готов" },
  { id: "project", title: "10 Проект" },
  { id: "project-updating", title: "11 Обновляется" },
  { id: "project-outdated", title: "12 Устарел" },
  { id: "person", title: "13 Профиль" },
  { id: "person-edit", title: "14 Редактирование" },
  { id: "person-add", title: "15 Добавить" },
  { id: "project-delete", title: "22 Удаление" },
];

// Screens of the projects flow. Not shipped in the production build.
export default function ProjectsScreensPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <ScreenFlow screens={SCREENS} title="Проекты">
      <ScreenFrame
        height={900}
        id="home"
        note="Клик по строке проекта → страница проекта, якорь «Бриф». Счётчик открытых вопросов: оранжевая точка, только если после последнего звонка появились новые, иначе серая. Логотипы в колонке «Источники» — только подключённые к проекту, ховер → подсказка. Звонок с неразобранными предложениями подсвечен серым фоном, клик → ревью предложений. «Новый проект» и плюс у раздела «Проекты» в сайдбаре открывают мастер."
        title="01 Главная — проекты"
        width={1440}
      >
        <HomeScreen className="size-full" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="first-run"
        note="Показывается после онбординга окружения, когда проектов ещё нет. «Создать проект» → мастер, шаг 1. Карточки шагов не кликабельны, это объяснение, а не навигация. Если звонок начнётся без проекта, виджет старта предложит «Без проекта», итоги потом можно привязать."
        title="02 Главная — первый запуск"
        width={1440}
      >
        <HomeScreen className="size-full" state="first-run" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-name"
        note="Мастер открывается в основной панели, сайдбар остаётся, в списке проектов временный пункт «Новый проект». Фокус сразу в поле «Название», Enter → следующий шаг, «Назад» неактивна на первом шаге. Клик по пройденному шагу слева → возврат к нему, будущие шаги не кликабельны. «Отмена» с заполненными полями → подтверждение «Выйти без сохранения?»."
        title="03 Новый проект — шаг 1, название"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="name" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-name-error"
        note="Проверка только по нажатию «Далее», не во время ввода. Поле подсвечивается красной рамкой, курсор возвращается в него. Текст ошибки объясняет зачем, ошибка исчезает с первым введённым символом. Если такое имя уже есть: «Проект с таким названием уже есть» и ссылка на него."
        title="04 Новый проект — шаг 1, ошибка"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="name-error" />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="new-sources"
        note="Интеграции подключаются один раз в настройках, здесь только выбор, что брать для проекта. Если интеграция не подключена, вместо выбора серая кнопка «Подключить Outline». GitHub: поиск фильтрует список, ховер подсвечивает строку, клик ставит галочку, счётчик «выбрано 2 из 4». «Пропустить» сворачивает блок в строку «Без Outline» со ссылкой «Вернуть». «Далее» доступна даже без источников."
        title="05 Новый проект — шаг 2, источники"
        width={1440}
      >
        <NewProjectScreen className="w-full" state="sources" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-people"
        note="Быстрое добавление: имя, роль, уровень в технике. Enter в любом поле → человек появляется в списке, фокус снова в «Имя». Крестик удаляет без подтверждения, внизу тост «Удалено, вернуть». Шаг можно пройти без людей: агент тогда формулирует вопросы нейтрально."
        title="06 Новый проект — шаг 3, люди клиента"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="people" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-notes"
        note="Свободный текст. Чипы-подсказки дописывают заголовок строки в конец поля. На последнем шаге кнопка меняется на «Собрать бриф» и запускает агента."
        title="07 Новый проект — шаг 4, заметки"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="notes" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-building"
        note="Проект уже создан и сохранён, агент работает в фоне. Строки обновляются вживую, под текущей видно, что именно агент читает. «Свернуть в фон» → главная, у проекта в сайдбаре крутится индикатор, по готовности системное уведомление. Если источник упал, строка становится красной с «Повторить» и «Пропустить», остальное продолжается."
        title="08 Новый проект — собираю бриф"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="building" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="new-ready"
        note="Короткая выжимка и расхождения, которые агент нашёл между источниками. Синим помечено допущение: агент выбрал вариант и спросит на звонке. «Открыть проект» → страница проекта, раздел «Бриф»."
        title="09 Новый проект — бриф готов"
        width={1440}
      >
        <NewProjectScreen className="size-full" state="ready" />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="project"
        note="Одна длинная страница с якорями: пилюли «Бриф / Люди / Звонки / Источники / Заметки» прилипают к верху при скролле, активная подсвечивается по позиции. Оранжевая плашка — только когда после звонка есть неразобранные предложения, «Разобрать» → ревью. Красная метка в брифе — противоречие между источниками, клик → откуда взялось и вопрос агента. Клик по карточке человека → профиль. «⋯» в шапке: «Экспорт брифа», «Удалить проект». Ховер на статусе источника → время синхронизации и «Синхронизировать сейчас»."
        title="10 Проект — бриф"
        width={1440}
      >
        <ProjectScreen className="w-full" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="project-updating"
        note="Клик «Обновить» → агент перечитывает только изменённое с прошлого раза. Старый бриф виден приглушённо, им можно пользоваться. Строка статуса пишет, что именно читается сейчас, тонкая оранжевая полоска показывает прогресс. После окончания изменённые абзацы на 3 секунды подсвечиваются мягким фоном, статус «Обновлён только что»."
        title="11 Проект — бриф обновляется"
        width={1440}
      >
        <ProjectScreen briefState="updating" className="size-full" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="project-outdated"
        note="Бриф считается устаревшим, если с обновления прошло больше 7 дней или в источниках много изменений. Тогда «Обновить бриф» становится главной чёрной кнопкой. Ошибка источника видна прямо в шапке красным, клик → «Источники». Если менеджер не обновит, агент сделает это сам при старте звонка и предупредит в виджете."
        title="12 Проект — бриф устарел"
        width={1440}
      >
        <ProjectScreen
          briefState="outdated"
          className="size-full"
          proposals={null}
        />
      </ScreenFrame>
      <ScreenFrame
        height="auto"
        id="person"
        note="Главное на экране — как формулировать вопросы: агент использует этот текст дословно, пример «вместо / спросит» показывает эффект. Предложение после звонка встроено в профиль: «Принять» применяет правку и добавляет запись в «Откуда профиль», «Изменить и принять» открывает поля в режиме правки, «Отклонить» → тост «Отклонено, вернуть». Цитата ведёт к моменту в расшифровке звонка (12:14)."
        title="13 Человек — профиль с предложением"
        width={1440}
      >
        <PersonScreen className="w-full" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="person-edit"
        note="Все поля становятся редактируемыми на месте, раскладка не прыгает. Шкалы кликаются по делениям, при ховере деление подсвечивается серым и справа виден новый уровень «не разбирается → базово». ⌘S сохраняет, Esc отменяет, при уходе со страницы с изменениями — подтверждение."
        title="14 Человек — редактирование"
        width={1440}
      >
        <PersonScreen className="size-full" mode="edit" />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="person-add"
        note="Открывается из «Люди клиента → Добавить» и из итогов звонка, если агент услышал новое имя (тогда поля уже заполнены). Обязательно только имя. Enter → «Добавить», Esc или клик по фону → закрыть. Крестик закрытия кликается в круге 32px, при наведении под ним светло-серый круг."
        title="15 Человек — диалог «Добавить»"
        width={1440}
      >
        <ProjectScreen
          className="size-full"
          dialog="add-person"
          proposals={null}
          sections={["people", "calls", "sources"]}
        />
      </ScreenFrame>
      <ScreenFrame
        height={900}
        id="project-delete"
        note="Вызывается из меню «⋯» в шапке проекта. Красная кнопка неактивна, пока название не введено точно. Галочка экспорта включена по умолчанию: перед удалением откроется выбор папки для Markdown-файлов. После удаления → главная и тост «Проект Телемедиа удалён», отмены нет, поэтому подтверждение вводом. Если идёт звонок по этому проекту, пункт меню неактивен с подсказкой «Сначала завершите звонок»."
        title="22 Удаление проекта — подтверждение"
        width={1440}
      >
        <ProjectScreen
          className="size-full"
          dialog="delete-project"
          proposals={null}
          sections={["people", "calls", "sources"]}
        />
      </ScreenFrame>
    </ScreenFlow>
  );
}
