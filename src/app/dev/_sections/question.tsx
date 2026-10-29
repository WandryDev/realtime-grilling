import { PinIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Question,
  QuestionAction,
  QuestionActions,
  QuestionAside,
  QuestionContent,
  QuestionDescription,
  QuestionStatus,
  QuestionTitle,
  QuestionTopic,
} from "@/components/ui/question";
import {
  QuestionHistory,
  QuestionHistoryAnswer,
  QuestionHistoryContent,
  QuestionHistoryHeader,
  QuestionHistoryItem,
  QuestionHistoryList,
  QuestionHistoryNote,
  QuestionHistoryQuestion,
  QuestionHistoryRestore,
  QuestionHistoryTime,
} from "@/components/ui/question-history";
import { SourceBadge } from "@/components/ui/source-badge";

import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
} from "../_components/showcase";

// Paper "05 Вопрос".

function Column({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-10">{children}</div>;
}

/** Hover actions of an open question. Hidden until hover or keyboard focus. */
function OpenActions() {
  return (
    <QuestionActions>
      <QuestionAction>Уже спросил</QuestionAction>
      <QuestionAction>Закрепить</QuestionAction>
      <QuestionAction>Скрыть</QuestionAction>
    </QuestionActions>
  );
}

function OpenQuestions() {
  return (
    <div className="grid grid-cols-2 items-start gap-8">
      <Column>
        <Specimen caption="Новый главный, 28px, мягкий оранжевый. Один на экран">
          <Question variant="main">
            <QuestionContent>
              <QuestionStatus>Новый, только что</QuestionStatus>
              <QuestionTitle>
                Записывать в CRM сам звонок или только факт и длительность?
              </QuestionTitle>
              <QuestionDescription>
                «Звонок туда записывался» можно понять по-разному
              </QuestionDescription>
            </QuestionContent>
          </Question>
        </Specimen>
        <Specimen caption="Обычный, с пояснением зачем спрашивать">
          <Question>
            <QuestionContent>
              <QuestionTitle>
                Сколько операторов работает в одну смену?
              </QuestionTitle>
              <QuestionDescription>
                Нужно для расчёта лицензий телефонии
              </QuestionDescription>
            </QuestionContent>
            <OpenActions />
          </Question>
        </Specimen>
        <Specimen caption="С меткой типа: противоречие, допущение, из кода">
          <Question>
            <QuestionContent>
              <QuestionTitle>
                Мобильное приложение входит в первый этап?
              </QuestionTitle>
              <QuestionDescription>
                Сначала «не трогаем», потом «тоже надо»
              </QuestionDescription>
            </QuestionContent>
            <QuestionAside>
              <Badge variant="contradiction">противоречие</Badge>
            </QuestionAside>
            <OpenActions />
          </Question>
        </Specimen>
        <Specimen caption="Входящий из ClickUp, ссылка на задачу справа">
          <Question>
            <QuestionContent>
              <QuestionTitle>
                Нужна ли история прошлых звонков в карточке?
              </QuestionTitle>
              <QuestionDescription>
                Андрей ждёт ответ, чтобы оценить задачу
              </QuestionDescription>
            </QuestionContent>
            <QuestionAside>
              <SourceBadge
                aria-label="Задача CU-517 в ClickUp"
                render={<a href="https://app.clickup.com/t/CU-517" />}
                source="clickup"
                taskId="CU-517"
              />
            </QuestionAside>
            <OpenActions />
          </Question>
        </Specimen>
        <Specimen caption="Закреплён: не уходит из списка, держится сверху темы">
          <Question>
            <QuestionContent>
              <QuestionTitle>
                Кто будет принимать работу со стороны клиента?
              </QuestionTitle>
              <QuestionDescription>
                Вы закрепили, спросить до конца звонка
              </QuestionDescription>
            </QuestionContent>
            <QuestionAside>
              <Badge className="text-foreground" variant="neutral">
                <PinIcon />
                закреплён
              </Badge>
            </QuestionAside>
          </Question>
        </Specimen>
      </Column>
      <Column>
        <Specimen caption="Наведение: серая подложка, справа действия Уже спросил, Закрепить, Скрыть">
          <Question data-preview="hover">
            <QuestionContent>
              <QuestionTitle>
                Карточку открывать только по номеру телефона?
              </QuestionTitle>
              <QuestionDescription>
                Предполагаю, что номер есть у всех пациентов в базе
              </QuestionDescription>
            </QuestionContent>
            <OpenActions />
          </Question>
        </Specimen>
        <Specimen caption="Только что отвечен: гаснет 3 с и уезжает в «Обсудили в этой теме»">
          <Question state="answered">
            <QuestionContent>
              <QuestionTitle>Сколько операторов будет на старте?</QuestionTitle>
              <QuestionDescription>
                «Пятеро. К лету до двадцати, если реклама пойдёт»
              </QuestionDescription>
            </QuestionContent>
            <QuestionAside>
              <Badge variant="confirmed">отвечен</Badge>
            </QuestionAside>
          </Question>
        </Specimen>
        <Specimen caption="Компактный, в прошлой теме, 16px">
          <Question variant="compact">
            <QuestionContent>
              <QuestionTitle>
                Очередь с музыкой — это решение или один из вариантов?
              </QuestionTitle>
              <QuestionDescription>
                Клиент сказал «наверное»
              </QuestionDescription>
            </QuestionContent>
          </Question>
        </Specimen>
        <Specimen caption="В финальной проверке: сверху тема, из которой вопрос">
          <Question>
            <QuestionContent>
              <QuestionTopic>Приём звонков</QuestionTopic>
              <QuestionTitle>
                Что происходит, если все операторы заняты?
              </QuestionTitle>
              <QuestionDescription tone="accent">
                Спросили в 12:14, ответа не было
              </QuestionDescription>
            </QuestionContent>
          </Question>
        </Specimen>
      </Column>
    </div>
  );
}

const HISTORY_CAPTIONS = [
  "Отвечен: вопрос серым, цитата клиента чёрным, время справа",
  "Отвечен по задаче ClickUp: зелёная строка, что ответ уйдёт в итоги",
  "Спросили без ответа: оранжевое кольцо, кнопка Вернуть",
  "Скрыт вами: крестик, кнопка Вернуть",
  "Неактуален: агент снял сам, с причиной и временем",
] as const;

// Grid rows for the header and five items, so captions line up with rows.
const CAPTION_ROWS = [
  "row-start-2",
  "row-start-3",
  "row-start-4",
  "row-start-5",
  "row-start-6",
] as const;

function History() {
  return (
    <ShowcaseGroup title="История в теме">
      <div className="grid grid-cols-2 grid-rows-[repeat(6,auto)] gap-x-8">
        <QuestionHistory className="col-start-1 row-span-6 row-start-1 grid grid-rows-subgrid">
          <QuestionHistoryHeader count={5}>
            Обсудили в этой теме
          </QuestionHistoryHeader>
          <QuestionHistoryList className="row-span-5 grid grid-rows-subgrid">
            <QuestionHistoryItem status="answered">
              <QuestionHistoryContent>
                <QuestionHistoryQuestion>
                  Какая CRM используется?
                </QuestionHistoryQuestion>
                <QuestionHistoryAnswer>«amoCRM»</QuestionHistoryAnswer>
              </QuestionHistoryContent>
              <QuestionHistoryTime>12:21</QuestionHistoryTime>
            </QuestionHistoryItem>
            <QuestionHistoryItem status="answered-task">
              <QuestionHistoryContent>
                <QuestionHistoryQuestion>
                  Перезванивать на пропущенные автоматически?
                </QuestionHistoryQuestion>
                <QuestionHistoryAnswer>
                  «Оператор сам, через 15 минут напомнить старшему смены»
                </QuestionHistoryAnswer>
                <QuestionHistoryNote>
                  Ответ попадёт в итоги для ClickUp
                </QuestionHistoryNote>
              </QuestionHistoryContent>
              <QuestionHistoryTime>12:16</QuestionHistoryTime>
            </QuestionHistoryItem>
            <QuestionHistoryItem status="unanswered">
              <QuestionHistoryContent>
                <QuestionHistoryQuestion>
                  Что происходит, если все операторы заняты?
                </QuestionHistoryQuestion>
                <QuestionHistoryNote>
                  Спросили, но ответа не было
                </QuestionHistoryNote>
              </QuestionHistoryContent>
              <QuestionHistoryRestore />
            </QuestionHistoryItem>
            <QuestionHistoryItem status="hidden">
              <QuestionHistoryContent>
                <QuestionHistoryQuestion>
                  Какой бюджет на телефонию в месяц?
                </QuestionHistoryQuestion>
                <QuestionHistoryNote>Вы скрыли</QuestionHistoryNote>
              </QuestionHistoryContent>
              <QuestionHistoryRestore />
            </QuestionHistoryItem>
            <QuestionHistoryItem status="irrelevant">
              <QuestionHistoryContent>
                <QuestionHistoryQuestion>
                  Звонки из рекламы идут в ту же очередь?
                </QuestionHistoryQuestion>
                <QuestionHistoryNote>
                  Неактуален, клиент сам рассказал в 12:06
                </QuestionHistoryNote>
              </QuestionHistoryContent>
              <QuestionHistoryTime>12:06</QuestionHistoryTime>
            </QuestionHistoryItem>
          </QuestionHistoryList>
        </QuestionHistory>
        {HISTORY_CAPTIONS.map((caption, index) => (
          <p
            className={`text-muted-foreground col-start-2 pt-[13px] text-sm ${CAPTION_ROWS[index]}`}
            key={caption}
          >
            {caption}
          </p>
        ))}
      </div>
    </ShowcaseGroup>
  );
}

export function QuestionSection() {
  return (
    <ShowcaseSection
      description="Подсказки агента на белой панели. Главный вопрос один, остальные строками без карточек."
      id="question"
      title="Вопрос"
    >
      <OpenQuestions />
      <History />
    </ShowcaseSection>
  );
}
