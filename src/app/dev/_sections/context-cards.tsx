import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextCard,
  ContextCardActions,
  ContextCardAlert,
  ContextCardAlertDescription,
  ContextCardAlertTitle,
  ContextCardBody,
  ContextCardCode,
  ContextCardEmpty,
  ContextCardEmptyContent,
  ContextCardEmptyDescription,
  ContextCardEmptySources,
  ContextCardEmptyTitle,
  ContextCardHeader,
  ContextCardHeading,
  ContextCardMeta,
  ContextCardOpen,
  ContextCardQuestionLink,
  ContextCardQuote,
  ContextCardQuoteMeta,
  ContextCardSearching,
  ContextCardSource,
  ContextCardStatus,
  ContextCardTime,
  ContextCardTitle,
  ContextColumnDescription,
  ContextColumnHeader,
  ContextColumnTitle,
} from "@/components/ui/context-card";
import { ShowcaseSection, Specimen, Stage } from "../_components/showcase";

// Paper "07 Карточки контекста". Every cell is the gray context column, 320 wide.

const OUTLINE_DOC_URL = "https://outline.telemedia.ru/doc/shift-lead";

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-16">{children}</div>;
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <Specimen caption={caption} className="w-[320px]">
      <Stage className="flex flex-col gap-2.5 px-2 py-3">{children}</Stage>
    </Specimen>
  );
}

function Findings() {
  return (
    <Row>
      <Cell caption="GitHub: репозиторий, вывод, файл и функции моноширинным">
        <ContextCard>
          <ContextCardHeader>
            <ContextCardSource source="github" />
            <ContextCardHeading>
              <ContextCardTitle>GitHub</ContextCardTitle>
              <ContextCardMeta mono>telemedia/backend</ContextCardMeta>
            </ContextCardHeading>
            <ContextCardTime>12:22</ContextCardTime>
          </ContextCardHeader>
          <ContextCardBody>
            Клиент amoCRM API v4 уже есть, используется для заявок с сайта
          </ContextCardBody>
          <ContextCardCode>
            {"integrations/amocrm/client.ts\ncreateLead(), findContact()"}
          </ContextCardCode>
          <ContextCardQuestionLink>
            к вопросу про текущую интеграцию
          </ContextCardQuestionLink>
        </ContextCard>
      </Cell>
      <Cell caption="Outline: документ и цитата с серой чертой">
        <ContextCard>
          <ContextCardHeader>
            <ContextCardSource source="outline" />
            <ContextCardHeading>
              <ContextCardTitle>Outline</ContextCardTitle>
              <ContextCardMeta>Архитектура телефонии</ContextCardMeta>
            </ContextCardHeading>
          </ContextCardHeader>
          <ContextCardQuote>
            Провайдер телефонии Mango Office, записи звонков хранятся у
            провайдера 90 дней.
          </ContextCardQuote>
          <ContextCardQuestionLink>
            к вопросу про запись звонка в CRM
          </ContextCardQuestionLink>
        </ContextCard>
      </Cell>
      <Cell caption="ClickUp: задача, комментарий автора, ждёт клиента">
        <ContextCard>
          <ContextCardHeader>
            <ContextCardSource source="clickup" />
            <ContextCardHeading>
              <ContextCardTitle>ClickUp</ContextCardTitle>
              <ContextCardMeta mono>CU-517</ContextCardMeta>
            </ContextCardHeading>
            <Badge className="h-[22px] px-2" variant="waiting">
              ждёт клиента
            </Badge>
          </ContextCardHeader>
          <ContextCardBody className="font-medium">
            Карточка пациента при входящем звонке
          </ContextCardBody>
          <ContextCardQuote>
            <ContextCardQuoteMeta>Андрей, 2 дня назад</ContextCardQuoteMeta>
            Не понятно, показывать ли историю прошлых звонков. От этого зависит
            оценка.
          </ContextCardQuote>
        </ContextCard>
      </Cell>
    </Row>
  );
}

function States() {
  return (
    <Row>
      <Cell caption="Поиск: пунктир, спиннер и что ищем">
        <ContextCardSearching>
          Ищу в Outline «старший смены»
        </ContextCardSearching>
        <ContextCardSearching>
          <span>Ищу в коде</span>
          <ContextCardMeta mono>telemedia/web</ContextCardMeta>
        </ContextCardSearching>
      </Cell>
      <Cell caption="Ошибка: красная точка и заголовок, объяснение и действие">
        <ContextCard>
          <ContextCardHeader>
            <ContextCardSource source="github" />
            <ContextCardHeading>
              <ContextCardTitle>GitHub</ContextCardTitle>
              <ContextCardMeta mono>telemedia/web</ContextCardMeta>
            </ContextCardHeading>
            <ContextCardStatus status="error" />
          </ContextCardHeader>
          <ContextCardAlert>
            <ContextCardAlertTitle>
              Нет доступа к репозиторию
            </ContextCardAlertTitle>
            <ContextCardAlertDescription>
              Ваш GitHub не видит telemedia/web. Попросите доступ у владельца
              организации или войдите заново.
            </ContextCardAlertDescription>
          </ContextCardAlert>
          <ContextCardActions>
            <Button size="sm" variant="secondary">
              Войти заново
            </Button>
            <Button className="px-3" size="sm" variant="ghost">
              Скрыть
            </Button>
          </ContextCardActions>
        </ContextCard>
      </Cell>
      <Cell caption="Пусто: логотипы подключённых источников">
        <ContextCardEmpty>
          <ContextCardEmptySources>
            <ContextCardSource source="outline" variant="outline" />
            <ContextCardSource source="github" variant="outline" />
            <ContextCardSource source="clickup" variant="outline" />
          </ContextCardEmptySources>
          <ContextCardEmptyContent>
            <ContextCardEmptyTitle>Пока ничего не нашли</ContextCardEmptyTitle>
            <ContextCardEmptyDescription>
              Агент ищет в документах, коде и задачах, когда в разговоре
              всплывает что-то знакомое
            </ContextCardEmptyDescription>
          </ContextCardEmptyContent>
          <Button
            className="bg-background shadow-touch"
            size="sm"
            variant="secondary"
          >
            Настроить источники
          </Button>
        </ContextCardEmpty>
      </Cell>
    </Row>
  );
}

function Interaction() {
  return (
    <Row>
      <Cell caption="Наведение: тень глубже, кнопка открыть в источнике, ссылка к вопросу темнеет">
        <ContextCard data-preview="hover">
          <ContextCardHeader>
            <ContextCardSource source="outline" />
            <ContextCardHeading>
              <ContextCardTitle>Outline</ContextCardTitle>
              <ContextCardMeta>Регламент старшего смены</ContextCardMeta>
            </ContextCardHeading>
            <ContextCardOpen
              aria-label="Открыть «Регламент старшего смены» в Outline"
              href={OUTLINE_DOC_URL}
              rel="noopener noreferrer"
              target="_blank"
            />
          </ContextCardHeader>
          <ContextCardQuote>
            Старший смены получает напоминания в Telegram-бот, пропущенные
            проверяет раз в час.
          </ContextCardQuote>
          <ContextCardQuestionLink>
            к вопросу про старшего смены
          </ContextCardQuestionLink>
        </ContextCard>
      </Cell>
      <Cell caption="Только что найдено: оранжевая точка «новое» на 10 с">
        <ContextCard>
          <ContextCardHeader>
            <ContextCardSource source="github" />
            <ContextCardHeading>
              <ContextCardTitle>GitHub</ContextCardTitle>
              <ContextCardMeta mono>telemedia/web</ContextCardMeta>
            </ContextCardHeading>
            <ContextCardStatus fade={false} status="new" />
          </ContextCardHeader>
          <ContextCardBody>
            Виджет обратного звонка на сайте уже шлёт номер в amoCRM
          </ContextCardBody>
          <ContextCardCode>src/widgets/callback.tsx</ContextCardCode>
        </ContextCard>
      </Cell>
      <Cell caption="Шапка колонки контекста">
        <ContextColumnHeader>
          <ContextColumnTitle>Контекст</ContextColumnTitle>
          <ContextColumnDescription>найдено по ходу</ContextColumnDescription>
        </ContextColumnHeader>
      </Cell>
    </Row>
  );
}

export function ContextCardsSection() {
  return (
    <ShowcaseSection
      description="Что агент нашёл в интеграциях. Белые карточки с тенью на сером, с логотипом источника. Вопросы так не выглядят."
      id="context-cards"
      title="Карточки контекста"
    >
      <Findings />
      <States />
      <Interaction />
    </ShowcaseSection>
  );
}
