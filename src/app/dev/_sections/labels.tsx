import { Badge } from "@grill/ui/badge";
import { Counter } from "@grill/ui/counter";
import { Kbd, KbdGroup } from "@grill/ui/kbd";
import { AgentStatus, RecordingIndicator } from "@grill/ui/recording-indicator";
import { SourceBadge } from "@grill/ui/source-badge";
import { TopicAnchor } from "@grill/ui/topic-anchor";
import type { ReactNode } from "react";
import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
  Stage,
} from "../_components/showcase";

// Paper "04 Метки и пилюли". The "Фильтр и вкладка" group lives in the tabs section.

function SpecimenRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-10">{children}</div>;
}

/** Fixed-height slot so captions line up across a row, as in Paper. */
function Slot({
  children,
  height,
}: {
  children: ReactNode;
  height: "h-8" | "h-[26px]" | "h-16";
}) {
  return <div className={`flex items-center ${height}`}>{children}</div>;
}

function TopicAnchors() {
  return (
    <ShowcaseGroup title="Якорь темы">
      <SpecimenRow>
        <Specimen caption="По умолчанию, есть открытые">
          <Slot height="h-8">
            <TopicAnchor count={2}>Приём звонков</TopicAnchor>
          </Slot>
        </Specimen>
        <Specimen caption="Наведение">
          <Slot height="h-8">
            <TopicAnchor count={2} data-preview="hover">
              Приём звонков
            </TopicAnchor>
          </Slot>
        </Specimen>
        <Specimen caption="Активная, идёт сейчас">
          <Slot height="h-8">
            <TopicAnchor active count={5}>
              Интеграция с CRM
            </TopicAnchor>
          </Slot>
        </Specimen>
        <Specimen caption="Фокус">
          <Slot height="h-8">
            <TopicAnchor count={2} data-preview="focus">
              Приём звонков
            </TopicAnchor>
          </Slot>
        </Specimen>
        <Specimen caption="Без новых, счётчик серый">
          <Slot height="h-8">
            <TopicAnchor count={1} countTone="neutral">
              Без темы
            </TopicAnchor>
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

function QuestionStatuses() {
  return (
    <ShowcaseGroup title="Статус вопроса">
      <SpecimenRow>
        <Specimen caption="Противоречие">
          <Slot height="h-[26px]">
            <Badge variant="contradiction">противоречие</Badge>
          </Slot>
        </Specimen>
        <Specimen caption="Допущение">
          <Slot height="h-[26px]">
            <Badge variant="assumption">допущение</Badge>
          </Slot>
        </Specimen>
        <Specimen caption="Подтверждено">
          <Slot height="h-[26px]">
            <Badge variant="confirmed">подтверждено</Badge>
          </Slot>
        </Specimen>
        <Specimen caption="Ждёт клиента">
          <Slot height="h-[26px]">
            <Badge variant="waiting">ждёт клиента</Badge>
          </Slot>
        </Specimen>
        <Specimen caption="Пробел в карточке">
          <Slot height="h-[26px]">
            <Badge variant="empty">пусто</Badge>
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

function QuestionSources() {
  return (
    <ShowcaseGroup title="Источник вопроса">
      <SpecimenRow>
        <Specimen caption="Из кода">
          <Slot height="h-[26px]">
            <SourceBadge source="code" />
          </Slot>
        </Specimen>
        <Specimen caption="ClickUp">
          <Slot height="h-[26px]">
            <SourceBadge source="clickup" />
          </Slot>
        </Specimen>
        <Specimen caption="Outline">
          <Slot height="h-[26px]">
            <SourceBadge source="outline" />
          </Slot>
        </Specimen>
        <Specimen caption="GitHub">
          <Slot height="h-[26px]">
            <SourceBadge source="github" />
          </Slot>
        </Specimen>
        <Specimen caption="Ссылка на задачу">
          <Slot height="h-[26px]">
            <SourceBadge
              aria-label="Задача CU-517 в ClickUp"
              render={<a href="https://app.clickup.com/t/CU-517" />}
              source="clickup"
              taskId="CU-517"
            />
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

function Counters() {
  return (
    <ShowcaseGroup title="Счётчики">
      <SpecimenRow>
        <Specimen caption="Есть открытые">
          <Slot height="h-[26px]">
            <Counter variant="open">2</Counter>
          </Slot>
        </Specimen>
        <Specimen caption="Нейтральный">
          <Slot height="h-[26px]">
            <Counter variant="neutral">4</Counter>
          </Slot>
        </Specimen>
        <Specimen caption="Новые, бейдж">
          <Slot height="h-[26px]">
            <Counter variant="new">3</Counter>
          </Slot>
        </Specimen>
        <Specimen caption="Счётчик с подписью">
          <Slot height="h-[26px]">
            <Counter label="незакрытых в прошлых темах" variant="soft">
              3
            </Counter>
          </Slot>
        </Specimen>
        <Specimen caption="В навигации">
          <Slot height="h-[26px]">
            <Counter variant="nav">12</Counter>
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

function Recording() {
  return (
    <ShowcaseGroup title="Запись и прослушивание">
      <SpecimenRow>
        <Specimen caption="Идёт запись">
          <Stage className="px-5">
            <RecordingIndicator time="24:18" />
          </Stage>
        </Specimen>
        <Specimen caption="Пауза">
          <Stage className="px-5">
            <RecordingIndicator paused time="24:18" />
          </Stage>
        </Specimen>
        <Specimen caption="Только началась, с подписью">
          <Stage className="px-5">
            <RecordingIndicator label="идёт запись" time="00:04" />
          </Stage>
        </Specimen>
        <Specimen caption="Агент слушает">
          <Slot height="h-16">
            <AgentStatus className="px-1" state="listening" />
          </Slot>
        </Specimen>
        <Specimen caption="Агент думает">
          <Slot height="h-16">
            <AgentStatus className="px-1" state="thinking" />
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

function Shortcuts() {
  return (
    <ShowcaseGroup title="Подсказка клавиш">
      <SpecimenRow>
        <Specimen caption="macOS">
          <Slot height="h-[26px]">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>H</Kbd>
            </KbdGroup>
          </Slot>
        </Specimen>
        <Specimen caption="Windows">
          <Slot height="h-[26px]">
            <KbdGroup>
              <Kbd>Ctrl</Kbd>
              <Kbd>H</Kbd>
            </KbdGroup>
          </Slot>
        </Specimen>
        <Specimen caption="С действием">
          <Slot height="h-[26px]">
            <span className="text-muted-foreground flex items-center gap-2.5 text-sm">
              Скрыть вопрос
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>H</Kbd>
              </KbdGroup>
            </span>
          </Slot>
        </Specimen>
        <Specimen caption="В подвале диалога">
          <Slot height="h-[26px]">
            <span className="text-muted-foreground flex items-center gap-2.5 text-sm">
              <Kbd>Esc</Kbd>
              закрыть
            </span>
          </Slot>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

export function LabelsSection() {
  return (
    <ShowcaseSection
      description="Якоря тем, статусы вопросов, источники, счётчики, запись и подсказки клавиш."
      id="labels"
      title="Метки и пилюли"
    >
      <TopicAnchors />
      <QuestionStatuses />
      <QuestionSources />
      <Counters />
      <Recording />
      <Shortcuts />
    </ShowcaseSection>
  );
}
