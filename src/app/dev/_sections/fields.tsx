"use client";

import { CheckIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SearchInput } from "@/components/ui/search-input";
import {
  Select,
  SelectAction,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectItemClassName,
  selectPopupClassName,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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
  "Фокус",
  "Заполнено",
  "Ошибка",
  "Отключено",
];

const PROJECTS = [
  { hint: undefined, label: "Телемедиа", value: "telemedia" },
  { hint: "вчера", label: "Ветклиника Лапа", value: "lapa" },
  { hint: "12 окт", label: "Логистик Про", value: "logistic-pro" },
  { hint: "3 окт", label: "Школа Ритм", value: "ritm" },
];

const PROJECT_ITEMS = Object.fromEntries(
  PROJECTS.map((project) => [project.value, project.label])
);

const NOTE = "Ольга решает быстро, детали уточнять у Игоря";

/** One matrix cell: a 176 wide field with an optional line underneath. */
function Cell({ children }: { children: ReactNode }) {
  return (
    <StateCell>
      <Field className="w-44">{children}</Field>
    </StateCell>
  );
}

function ProjectSelect({
  defaultValue,
  disabled,
  preview,
}: {
  defaultValue?: string;
  disabled?: boolean;
  preview?: string;
}) {
  return (
    <Select
      defaultValue={defaultValue}
      disabled={disabled}
      items={PROJECT_ITEMS}
    >
      <SelectTrigger aria-label="Проект" data-preview={preview}>
        <SelectValue placeholder="Проект" />
      </SelectTrigger>
      <SelectContent
        footer={
          <>
            <SelectSeparator />
            <SelectAction>
              <PlusIcon aria-hidden />
              Новый проект
            </SelectAction>
          </>
        }
      >
        {PROJECTS.map((project) => (
          <SelectItem
            hint={project.hint}
            key={project.value}
            value={project.value}
          >
            {project.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/*
 * The open menu, drawn in place: a live popup would portal over the page and
 * take focus on load. Same classes as SelectContent and SelectItem.
 */
function OpenMenuPreview() {
  return (
    <div className={cn(selectPopupClassName, "flex flex-col")} inert>
      {PROJECTS.map((project, index) => (
        <div
          className={selectItemClassName}
          data-highlighted={index === 1 ? "" : undefined}
          key={project.value}
        >
          <span className="flex-1 truncate">{project.label}</span>
          {project.hint ? (
            <span className="text-muted-foreground shrink-0 text-sm">
              {project.hint}
            </span>
          ) : null}
          {index === 0 ? (
            <CheckIcon aria-hidden className="size-3.5" strokeWidth={2.5} />
          ) : null}
        </div>
      ))}
      <div className="bg-border my-1 h-px" />
      <SelectAction tabIndex={-1}>
        <PlusIcon aria-hidden />
        Новый проект
      </SelectAction>
    </div>
  );
}

export function FieldsSection() {
  return (
    <ShowcaseSection
      description="Поля ввода со скруглением 12 и тонкой рамкой. Подпись сверху, ошибка снизу одной строкой."
      id="fields"
      title="Поля"
    >
      <StateTable columns={STATES}>
        <StateRow hint="высота 40" label="Текст">
          <Cell>
            <Input
              aria-label="Название проекта"
              placeholder="Название проекта"
            />
          </Cell>
          <Cell>
            <Input
              aria-label="Название проекта"
              data-preview="hover"
              placeholder="Название проекта"
            />
          </Cell>
          <Cell>
            <Input
              aria-label="Название проекта"
              data-preview="focus"
              defaultValue="Телеме"
            />
          </Cell>
          <Cell>
            <Input aria-label="Название проекта" defaultValue="Телемедиа" />
          </Cell>
          <Cell>
            <Input
              aria-label="Название проекта"
              defaultValue="Ветклиника Лапа"
            />
            <FieldError>Такой проект уже есть</FieldError>
          </Cell>
          <Cell>
            <Input
              aria-label="Название проекта"
              defaultValue="Телемедиа"
              disabled
            />
          </Cell>
        </StateRow>

        <StateRow hint="скрыт, глаз показывает" label="API-ключ">
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              placeholder="Ключ Outline"
            />
          </Cell>
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              data-preview="hover"
              placeholder="Ключ Outline"
            />
          </Cell>
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              data-preview="focus"
              defaultValue="ol_7Hq2kx9f"
              defaultVisible
            />
            <FieldDescription>Ключ показан</FieldDescription>
          </Cell>
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              defaultValue="ol_4mT8q3f9a"
            />
          </Cell>
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              defaultValue="ol_9Xc2r7b21"
            />
            <FieldError>Outline не принял ключ</FieldError>
          </Cell>
          <Cell>
            <PasswordInput
              aria-label="Ключ Outline"
              defaultValue="ol_4mT8q3f9a"
              disabled
            />
          </Cell>
        </StateRow>

        <StateRow hint="меню ниже" label="Выбор">
          <Cell>
            <ProjectSelect />
          </Cell>
          <Cell>
            <ProjectSelect preview="hover" />
          </Cell>
          <Cell>
            <ProjectSelect defaultValue="telemedia" preview="focus" />
          </Cell>
          <Cell>
            <ProjectSelect defaultValue="telemedia" />
          </Cell>
          <Cell>
            <ProjectSelect />
            <FieldError>Выберите проект звонка</FieldError>
          </Cell>
          <Cell>
            <ProjectSelect defaultValue="telemedia" disabled />
          </Cell>
        </StateRow>

        <StateRow hint="от 88 по высоте" label="Заметка">
          <Cell>
            <Textarea
              aria-label="Заметка"
              placeholder="Что важно помнить о клиенте"
            />
          </Cell>
          <Cell>
            <Textarea
              aria-label="Заметка"
              data-preview="hover"
              placeholder="Что важно помнить о клиенте"
            />
          </Cell>
          <Cell>
            <Textarea
              aria-label="Заметка"
              data-preview="focus"
              defaultValue="Ольга решает быстро"
            />
          </Cell>
          <Cell>
            <Textarea aria-label="Заметка" defaultValue={NOTE} />
          </Cell>
          <Cell>
            <Textarea aria-label="Заметка" defaultValue={NOTE} />
            <FieldError>Не сохранилось, повторите</FieldError>
          </Cell>
          <Cell>
            <Textarea aria-label="Заметка" defaultValue={NOTE} disabled />
          </Cell>
        </StateRow>

        <StateRow hint="пилюля на сером" label="Поиск">
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              placeholder="Поиск по звонкам"
            />
          </Cell>
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              data-preview="hover"
              placeholder="Поиск по звонкам"
            />
          </Cell>
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              data-preview="focus"
              placeholder="Поиск по звонкам"
            />
          </Cell>
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              defaultValue="amoCRM"
              placeholder="Поиск по звонкам"
            />
            <FieldDescription>Найдено в 3 звонках</FieldDescription>
          </Cell>
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              defaultValue="Mango"
              placeholder="Поиск по звонкам"
            />
            <FieldError>Индекс звонков повреждён</FieldError>
          </Cell>
          <Cell>
            <SearchInput
              aria-label="Поиск по звонкам"
              disabled
              placeholder="Поиск по звонкам"
            />
          </Cell>
        </StateRow>
      </StateTable>

      <ShowcaseGroup title="Выбор, открыт">
        <div className="flex flex-wrap items-start gap-16">
          <Specimen caption="Открыт, пункт под курсором подсвечен серым, выбранный с галочкой">
            <Field className="w-70">
              <FieldLabel>Проект</FieldLabel>
              <Select defaultValue="telemedia" items={PROJECT_ITEMS}>
                <SelectTrigger data-popup-open="" data-preview="focus">
                  <SelectValue placeholder="Проект" />
                </SelectTrigger>
                <SelectContent>
                  {PROJECTS.map((project) => (
                    <SelectItem
                      hint={project.hint}
                      key={project.value}
                      value={project.value}
                    >
                      {project.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <OpenMenuPreview />
            </Field>
          </Specimen>
          <Specimen caption="Поле целиком: подпись, поле, подсказка">
            <Field className="w-70">
              <FieldLabel>Ключ API Outline</FieldLabel>
              <PasswordInput defaultValue="ol_2Vb7Np4Lq9Wdx3f9a" />
              <FieldDescription>
                Хранится в Keychain, видите только вы
              </FieldDescription>
            </Field>
          </Specimen>
        </div>
      </ShowcaseGroup>
    </ShowcaseSection>
  );
}
