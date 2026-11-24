import { Button } from "@grill/ui/button";
import { EllipsisIcon, XIcon } from "lucide-react";

import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
  StateCell,
  StateRow,
  StateTable,
} from "../_components/showcase";

const STATES = [
  "По умолчанию",
  "Наведение",
  "Нажата",
  "Фокус",
  "Отключена",
  "Загрузка",
];

type Variant = "default" | "secondary" | "ghost" | "destructive";

const ROWS: {
  hint: string;
  label: string;
  loadingText: string;
  text: string;
  variant: Variant;
}[] = [
  {
    hint: "чёрная, одна на экран",
    label: "Главная",
    loadingText: "Запускаю",
    text: "Начать звонок",
    variant: "default",
  },
  {
    hint: "серая пилюля",
    label: "Вторичная",
    loadingText: "Проверяю",
    text: "Вернуть",
    variant: "secondary",
  },
  {
    hint: "без подложки",
    label: "Текстовая",
    loadingText: "Обновляю",
    text: "Свернуть",
    variant: "ghost",
  },
  {
    hint: "только в диалогах",
    label: "Опасная",
    loadingText: "Удаляю",
    text: "Удалить звонок",
    variant: "destructive",
  },
];

const SIZES = [
  {
    caption: "28, строки и карточки, текст 13",
    iconSize: "icon-sm",
    primary: "Завершить",
    secondary: "Вернуть",
    size: "sm",
  },
  {
    caption: "32, шапка окна и панели, текст 13",
    iconSize: "icon",
    primary: "Завершить",
    secondary: "Вернуть",
    size: "default",
  },
  {
    caption: "40, виджеты и диалоги, текст 14",
    iconSize: "icon-lg",
    primary: "Начать звонок",
    secondary: "Позже",
    size: "lg",
  },
] as const;

const CELL = "align-middle";

export function ButtonsSection() {
  return (
    <ShowcaseSection
      description="Все кнопки — пилюли. Чёрная главная одна на экран, остальные серые или текстовые."
      id="buttons"
      title="Кнопки"
    >
      <StateTable columns={STATES}>
        {ROWS.map((row) => (
          <StateRow hint={row.hint} key={row.variant} label={row.label}>
            <StateCell className={CELL}>
              <Button variant={row.variant}>{row.text}</Button>
            </StateCell>
            <StateCell className={CELL}>
              <Button data-preview="hover" variant={row.variant}>
                {row.text}
              </Button>
            </StateCell>
            <StateCell className={CELL}>
              <Button data-preview="active" variant={row.variant}>
                {row.text}
              </Button>
            </StateCell>
            <StateCell className={CELL}>
              <Button data-preview="focus" variant={row.variant}>
                {row.text}
              </Button>
            </StateCell>
            <StateCell className={CELL}>
              <Button disabled variant={row.variant}>
                {row.text}
              </Button>
            </StateCell>
            <StateCell className={CELL}>
              <Button loading variant={row.variant}>
                {row.loadingText}
              </Button>
            </StateCell>
          </StateRow>
        ))}
        <StateRow
          hint="круг 32, иконка 16, у каждой подсказка с названием"
          label="Иконка"
        >
          <StateCell className={CELL}>
            <Button aria-label="Ещё" size="icon" variant="secondary">
              <EllipsisIcon />
            </Button>
          </StateCell>
          <StateCell className={CELL}>
            <Button
              aria-label="Ещё"
              data-preview="hover"
              size="icon"
              variant="secondary"
            >
              <EllipsisIcon />
            </Button>
          </StateCell>
          <StateCell className={CELL}>
            <Button
              aria-label="Ещё"
              data-preview="active"
              size="icon"
              variant="secondary"
            >
              <EllipsisIcon />
            </Button>
          </StateCell>
          <StateCell className={CELL}>
            <Button
              aria-label="Ещё"
              data-preview="focus"
              size="icon"
              variant="secondary"
            >
              <EllipsisIcon />
            </Button>
          </StateCell>
          <StateCell className={CELL}>
            <Button aria-label="Ещё" disabled size="icon" variant="secondary">
              <EllipsisIcon />
            </Button>
          </StateCell>
          <StateCell className={CELL}>
            <Button aria-label="Ещё" loading size="icon" variant="secondary">
              <EllipsisIcon />
            </Button>
          </StateCell>
        </StateRow>
      </StateTable>

      <ShowcaseGroup title="Размеры">
        <div className="flex flex-wrap items-end gap-16">
          {SIZES.map((item) => (
            <Specimen caption={item.caption} key={item.size}>
              <div className="flex items-center gap-2">
                <Button size={item.size}>{item.primary}</Button>
                <Button size={item.size} variant="secondary">
                  {item.secondary}
                </Button>
                <Button
                  aria-label="Закрыть"
                  size={item.iconSize}
                  variant="secondary"
                >
                  <XIcon />
                </Button>
              </div>
            </Specimen>
          ))}
        </div>
      </ShowcaseGroup>
    </ShowcaseSection>
  );
}
