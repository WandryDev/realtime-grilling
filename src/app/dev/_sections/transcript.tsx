import { ClockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AvatarFallback } from "@/components/ui/avatar";
import { Bubble } from "@/components/ui/bubble";
import {
  Marker,
  MarkerAction,
  MarkerContent,
  MarkerDot,
  MarkerIcon,
  MarkerTime,
} from "@/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageSpeaking,
  MessageTyping,
} from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { TopicDivider } from "@/components/ui/topic-divider";
import { ShowcaseSection, Specimen, Stage } from "../_components/showcase";

// Paper "06 Сообщения расшифровки". Every cell is the gray transcript column, 340 wide.

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-12">{children}</div>;
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <Specimen caption={caption} className="w-[340px]">
      <Stage className="flex flex-col gap-[18px] px-4 py-5">{children}</Stage>
    </Specimen>
  );
}

function ClientAvatar({ speaking = false }: { speaking?: boolean }) {
  return (
    <MessageAvatar speaking={speaking}>
      <AvatarFallback>К</AvatarFallback>
    </MessageAvatar>
  );
}

function Messages() {
  return (
    <Row>
      <Cell caption="Клиент: белый пузырь, аватар К, имя сверху">
        <Message>
          <ClientAvatar />
          <MessageContent>
            <MessageHeader>Клиент</MessageHeader>
            <Bubble variant="card">
              Сейчас звонки с сайта идут на личные телефоны менеджеров, половину
              мы теряем. Хотим, чтобы попадали сразу операторам.
            </Bubble>
          </MessageContent>
        </Message>
      </Cell>
      <Cell caption="Вы: чёрный пузырь справа, без аватара">
        <Message align="end">
          <MessageContent>
            <MessageHeader>Вы</MessageHeader>
            <Bubble>Сколько операторов будет на старте?</Bubble>
          </MessageContent>
        </Message>
      </Cell>
      <Cell caption="Говорит сейчас: оранжевое кольцо, точки набора">
        <Message>
          <ClientAvatar speaking />
          <MessageContent>
            <MessageHeader>
              Клиент
              <MessageSpeaking />
            </MessageHeader>
            <Bubble variant="card">
              Подрядчик, но доступы есть у Игоря. Он сможет выдать ключ, если
              надо
              <MessageTyping />
            </Bubble>
          </MessageContent>
        </Message>
      </Cell>
    </Row>
  );
}

function Footers() {
  return (
    <Row>
      <Cell caption="Подвал: ответ на вопрос">
        <Message>
          <ClientAvatar />
          <MessageContent>
            <MessageHeader>Клиент</MessageHeader>
            <Bubble variant="card">
              Пятеро. К лету до двадцати, если реклама пойдёт.
            </Bubble>
            <MessageFooter status="answered">ответ на вопрос</MessageFooter>
          </MessageContent>
        </Message>
      </Cell>
      <Cell caption="Подвал: противоречие со ссылкой на время">
        <Message>
          <ClientAvatar />
          <MessageContent>
            <MessageHeader>Клиент</MessageHeader>
            <Bubble variant="card">
              Кстати, из приложения тоже звонят, это половина обращений. Её тоже
              надо завести.
            </Bubble>
            <MessageFooter status="contradiction">
              противоречит сказанному в <button type="button">12:06</button>
            </MessageFooter>
          </MessageContent>
        </Message>
      </Cell>
      <Cell caption="Подвал: допущение">
        <Message>
          <ClientAvatar />
          <MessageContent>
            <MessageHeader>Клиент</MessageHeader>
            <Bubble variant="card">
              Карточку, наверное, по номеру будем искать, он же у всех есть.
            </Bubble>
            <MessageFooter status="assumption">
              допущение, стоит уточнить
            </MessageFooter>
          </MessageContent>
        </Message>
      </Cell>
    </Row>
  );
}

function GroupsTopicsSystem() {
  return (
    <Row>
      <Cell caption="Подряд: имя и аватар один раз, хвостик только у последнего">
        <MessageGroup>
          <Message>
            <ClientAvatar />
            <MessageContent>
              <MessageHeader>Клиент</MessageHeader>
              <Bubble variant="card">Операторов у нас пятеро.</Bubble>
              <Bubble variant="card">
                Летом наберём ещё, если реклама пойдёт.
              </Bubble>
            </MessageContent>
          </Message>
          <Message align="end">
            <MessageContent>
              <MessageHeader>Вы</MessageHeader>
              <Bubble>Понял.</Bubble>
              <Bubble>А в выходные кто принимает?</Bubble>
            </MessageContent>
          </Message>
        </MessageGroup>
      </Cell>
      <Cell caption="Разделитель темы. Текущая с оранжевой точкой">
        <TopicDivider time="12:01">Приём звонков</TopicDivider>
        <TopicDivider current time="12:21">
          Интеграция с CRM
        </TopicDivider>
      </Cell>
      <Cell caption="Системные: по центру, без пузыря">
        <div className="flex flex-col gap-3.5">
          <Marker>
            <MarkerIcon>
              <ClockIcon absoluteStrokeWidth strokeWidth={1.5} />
            </MarkerIcon>
            <MarkerContent>Агент не ответил за 20 с</MarkerContent>
            <MarkerAction>Повторить</MarkerAction>
          </Marker>
          <Marker>
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>Расшифровка отстаёт на</MarkerContent>
            <MarkerTime>40 с</MarkerTime>
          </Marker>
          <Marker tone="destructive">
            <MarkerDot />
            <MarkerContent>Нет звука клиента с 12:30</MarkerContent>
            <MarkerAction>Проверить звук</MarkerAction>
          </Marker>
          <Marker variant="separator">
            <MarkerContent>пауза в записи 12:32–12:34</MarkerContent>
          </Marker>
        </div>
      </Cell>
    </Row>
  );
}

export function TranscriptSection() {
  return (
    <ShowcaseSection
      description="Паттерн Message: аватар, имя сверху, пузырь и подвал с меткой. Живут на сером фоне колонки шириной 340."
      id="transcript"
      title="Сообщения расшифровки"
    >
      <Messages />
      <Footers />
      <GroupsTopicsSystem />
    </ShowcaseSection>
  );
}
