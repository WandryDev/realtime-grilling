import { Avatar, AvatarFallback } from "@grill/ui/avatar";
import {
  ClaudeIcon,
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@grill/ui/brand-icons";
import { Button } from "@grill/ui/button";
import { CallRow } from "@grill/ui/call-row";
import { IntegrationCode, IntegrationRow } from "@grill/ui/integration-row";
import {
  PersonChip,
  PersonChipAdd,
  PersonChipRemove,
} from "@grill/ui/person-chip";
import { ProfileRow } from "@grill/ui/profile-row";
import { ProjectRow } from "@grill/ui/project-row";
import { SetupStep } from "@grill/ui/setup-step";
import type { ReactNode } from "react";
import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
} from "../_components/showcase";

// Paper "08 Строки списков". Rows are 720px wide with the state caption on the right.

/** One row of the artboard: the 720px specimen and its caption. */
function Line({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-12">
      <div className="w-[720px] shrink-0">{children}</div>
      <p className="text-muted-foreground text-sm">{caption}</p>
    </div>
  );
}

function Rows({
  children,
  divided = false,
}: {
  children: ReactNode;
  divided?: boolean;
}) {
  return (
    <div className={divided ? "flex flex-col" : "flex flex-col gap-1"}>
      {children}
    </div>
  );
}

const OLGA = { initials: "ОД", name: "Ольга Демченко" };
const IGOR = { initials: "ИС", name: "Игорь Савчук" };
const ANNA = { initials: "АК", name: "Анна Ковалёва" };

function Integrations() {
  return (
    <ShowcaseGroup title="Интеграция">
      <Rows divided>
        <Line caption="Подключено">
          <IntegrationRow
            action={
              <Button className="px-3" size="sm" variant="ghost">
                Настроить
              </Button>
            }
            description="Документация, коллекция «Телемедиа»"
            icon={<OutlineIcon />}
            name="Outline"
            status="connected"
          />
        </Line>
        <Line caption="Не подключено">
          <IntegrationRow
            action={
              <Button size="sm" variant="secondary">
                Подключить
              </Button>
            }
            description="Задачи и комментарии, только чтение"
            icon={<ClickUpIcon />}
            name="ClickUp"
            status="disconnected"
          />
        </Line>
        <Line caption="Подключается, OAuth device flow с кодом">
          <IntegrationRow
            action={
              <Button className="px-3" size="sm" variant="ghost">
                Отменить
              </Button>
            }
            description={
              <>
                Введите код в браузере{" "}
                <IntegrationCode>KX7P-2M4Q</IntegrationCode>
              </>
            }
            icon={<GitHubIcon />}
            name="GitHub"
            status="connecting"
          />
        </Line>
        <Line caption="Ошибка, причина в описании">
          <IntegrationRow
            action={
              <Button size="sm" variant="secondary">
                Обновить ключ
              </Button>
            }
            className="border-b-0"
            description="Ключ отозван, поиск по докам не работает"
            icon={<OutlineIcon />}
            name="Outline"
            status="error"
          />
        </Line>
      </Rows>
    </ShowcaseGroup>
  );
}

function Calls() {
  return (
    <ShowcaseGroup title="Звонок в истории">
      <Rows>
        <Line caption="Идёт сейчас">
          <CallRow
            date="Сегодня"
            duration="24:18"
            live
            time="12:00"
            title="Телемедиа"
            topics="Приём звонков, Интеграция с CRM"
          />
        </Line>
        <Line caption="По умолчанию, есть незакрытые вопросы">
          <CallRow
            date="Вчера"
            duration="38:12"
            openCount={3}
            time="12:30"
            title="Ветклиника Лапа"
            topics="Онлайн-запись, Напоминания клиентам"
          />
        </Line>
        <Line caption="Наведение: серая подложка, скругление 12">
          <CallRow
            data-preview="hover"
            date="15 окт"
            duration="22:40"
            openCount={0}
            time="12:10"
            title="Логистик Про"
            topics="Трекинг для водителей"
          />
        </Line>
        <Line caption="Выбран: серая подложка и чёрная полоска слева">
          <CallRow
            date="12 окт"
            duration="41:05"
            openCount={1}
            selected
            time="12:40"
            title="Школа Ритм"
            topics="Расписание и абонементы"
          />
        </Line>
      </Rows>
    </ShowcaseGroup>
  );
}

function Projects() {
  return (
    <ShowcaseGroup title="Проект">
      <Rows>
        <Line caption="По умолчанию">
          <ProjectRow
            description="Последний звонок сегодня, бриф обновлён вчера"
            name="Телемедиа"
            openCount={5}
            participants={[OLGA, IGOR]}
          />
        </Line>
        <Line caption="Наведение: подложка и действие справа">
          <ProjectRow
            data-preview="hover"
            description="Последний звонок вчера"
            name="Ветклиника Лапа"
            openCount={2}
            participants={[ANNA]}
          />
        </Line>
        <Line caption="Бриф устарел">
          <ProjectRow
            briefOutdated
            description="Бриф устарел, обновим перед звонком"
            name="Школа Ритм"
          />
        </Line>
      </Rows>
    </ShowcaseGroup>
  );
}

/** Fixed 32px slot so the chip captions line up, as in Paper. */
function ChipSlot({ children }: { children: ReactNode }) {
  return <div className="flex h-8 items-center">{children}</div>;
}

function People() {
  return (
    <ShowcaseGroup title="Человек клиента">
      <div className="flex flex-wrap items-start gap-10">
        <Specimen caption="Чип, по умолчанию">
          <ChipSlot>
            <PersonChip initials={OLGA.initials} name={OLGA.name} />
          </ChipSlot>
        </Specimen>
        <Specimen caption="Наведение, можно убрать">
          <ChipSlot>
            <PersonChip
              data-preview="hover"
              initials={IGOR.initials}
              name={IGOR.name}
            >
              <PersonChipRemove />
            </PersonChip>
          </ChipSlot>
        </Specimen>
        <Specimen caption="Добавить участника">
          <ChipSlot>
            <PersonChipAdd />
          </ChipSlot>
        </Specimen>
        <Specimen caption="Аватар 26">
          <ChipSlot>
            <Avatar size="sm">
              <AvatarFallback>К</AvatarFallback>
            </Avatar>
          </ChipSlot>
        </Specimen>
        <Specimen caption="Говорит">
          <ChipSlot>
            <Avatar size="sm" speaking>
              <AvatarFallback>К</AvatarFallback>
            </Avatar>
          </ChipSlot>
        </Specimen>
      </div>
      <div className="pt-3">
        <Rows>
          <Line caption="Строка профиля">
            <ProfileRow
              description="CEO, решает быстро, в технике разбирается мало"
              initials={OLGA.initials}
              name={OLGA.name}
              tags={["без жаргона"]}
            />
          </Line>
          <Line caption="Наведение, есть предложение после звонка">
            <ProfileRow
              data-preview="hover"
              description="Техлид, выдаёт доступы к amoCRM"
              initials={IGOR.initials}
              name={IGOR.name}
              updateSuggested
            />
          </Line>
        </Rows>
      </div>
    </ShowcaseGroup>
  );
}

function EnvironmentChecks() {
  return (
    <ShowcaseGroup title="Шаг проверки окружения">
      <Rows divided>
        <Line caption="Готово">
          <SetupStep
            description={
              <code className="font-mono text-xs">
                /usr/local/bin/claude, 2.1.4
              </code>
            }
            icon={<ClaudeIcon />}
            status="done"
            title="Claude Code установлен"
          />
        </Line>
        <Line caption="Не хватает, есть действие">
          <SetupStep
            action={
              <Button size="sm" variant="secondary">
                Войти
              </Button>
            }
            description="Откроем браузер, терминал не нужен"
            status="missing"
            title="Вход в аккаунт Claude"
          />
        </Line>
        <Line caption="Исправляем сами, с прогрессом">
          <SetupStep
            description="Скачиваю Whisper large-v3-turbo, 1 из 1,6 ГБ"
            progress={62}
            status="fixing"
            title="Модель распознавания речи"
          />
        </Line>
        <Line caption="Ошибка, ведём в системные настройки">
          <SetupStep
            action={
              <Button size="sm" variant="secondary">
                Открыть настройки
              </Button>
            }
            className="border-b-0"
            description="macOS не дал доступ, без него не слышно клиента"
            status="error"
            title="Запись системного звука"
          />
        </Line>
      </Rows>
    </ShowcaseGroup>
  );
}

export function ListRowsSection() {
  return (
    <ShowcaseSection
      description="Интеграции, звонки, проекты, люди и проверка окружения. Иконка и действие в колонках фиксированной ширины."
      id="list-rows"
      title="Строки списков"
    >
      <Integrations />
      <Calls />
      <Projects />
      <People />
      <EnvironmentChecks />
    </ShowcaseSection>
  );
}
