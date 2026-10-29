import type { ReactNode } from "react";

import {
  AppWindow,
  AppWindowBody,
  AppWindowPanel,
} from "@/components/ui/app-window";
import { ZoomIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  CallWidget,
  CallWidgetAddPerson,
  CallWidgetContent,
  CallWidgetDescription,
  CallWidgetFooter,
  CallWidgetHeader,
  CallWidgetPeople,
  CallWidgetPerson,
  CallWidgetSelectTrigger,
  CallWidgetTitle,
} from "@/components/ui/call-widget";
import { Counter } from "@/components/ui/counter";
import {
  NavItem,
  NavItemError,
  NavItemLabel,
  NavItemRecording,
  NavMenu,
} from "@/components/ui/nav-item";
import { RecordingIndicator } from "@/components/ui/recording-indicator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WindowControl,
  WindowControlGroup,
  WindowControls,
  WindowSubtitle,
  WindowTitle,
  WindowTitlebar,
  WindowTitlebarEnd,
  WindowTitlebarStart,
  WindowTrafficLights,
} from "@/components/ui/window-titlebar";
import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
} from "../_components/showcase";

// Paper "10 Окна и оболочки".

const PROJECTS = [
  { label: "Телемедиа", value: "telemedia" },
  { label: "Ветклиника Лапа", value: "lapa" },
  { label: "Логистик Про", value: "logistic-pro" },
];

const PROJECT_ITEMS = Object.fromEntries(
  PROJECTS.map((project) => [project.value, project.label])
);

// Links in the specimens point back at the section
const HREF = "#windows";

/* Navigation icons from the Paper file, 16px, 1.5 stroke. */
function PhoneIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth={1.4}
      viewBox="0 0 16 16"
    >
      <path d="M5.5 3.5C5.5 3.5 4 3.5 3.5 4.5C3 5.5 3.5 8 6 10.5C8.5 13 11 13 11.8 12.5C12.6 12 12.5 10.5 12.5 10.5L10.5 9L9 10C9 10 8 9.8 7 8.8C6 7.8 6 7 6 7L7 5.5L5.5 3.5Z" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      <rect height="10" rx="2" width="11" x="2.5" y="3" />
      <path d="M2.5 6.5H13.5" />
    </svg>
  );
}

function IntegrationsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      <circle cx="5" cy="5" r="2" />
      <circle cx="11" cy="11" r="2" />
      <path d="M7 5H11V9" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8V3.6M8 12.4V14.2M14.2 8H12.4M3.6 8H1.8M12.4 3.6L11.1 4.9M4.9 11.1L3.6 12.4M12.4 12.4L11.1 11.1M4.9 4.9L3.6 3.6" />
    </svg>
  );
}

/** The titlebar sits on the window's gray, rounded on top like the window. */
function WindowTop({ children }: { children: ReactNode }) {
  return (
    <div className="bg-surface w-full overflow-clip rounded-t-lg">
      {children}
    </div>
  );
}

function CallTitle() {
  return (
    <WindowTitle>
      Телемедиа
      <WindowSubtitle>с Ольгой и Игорем</WindowSubtitle>
    </WindowTitle>
  );
}

function MacTitlebars() {
  return (
    <ShowcaseGroup title="Шапка окна, macOS">
      <Specimen caption="56px: серые светофоры, проект и участники, справа запись и одна чёрная кнопка">
        <WindowTop>
          <WindowTitlebar>
            <WindowTitlebarStart>
              <WindowTrafficLights />
              <CallTitle />
            </WindowTitlebarStart>
            <WindowTitlebarEnd>
              <RecordingIndicator time="24:18" />
              <Button>Завершить</Button>
            </WindowTitlebarEnd>
          </WindowTitlebar>
        </WindowTop>
      </Specimen>
    </ShowcaseGroup>
  );
}

function WindowsTitlebars() {
  return (
    <ShowcaseGroup title="Шапка окна, Windows">
      <Specimen caption="Без светофоров, справа системные кнопки 46 на 56 тонкими линиями">
        <WindowTop>
          <WindowTitlebar>
            <WindowTitlebarStart>
              <CallTitle />
            </WindowTitlebarStart>
            <WindowTitlebarEnd>
              <RecordingIndicator time="24:18" />
              <Button>Завершить</Button>
              <WindowControls />
            </WindowTitlebarEnd>
          </WindowTitlebar>
        </WindowTop>
      </Specimen>
      <div className="flex flex-wrap items-start gap-10">
        <Specimen caption="Наведение на развернуть">
          <WindowControlGroup className="bg-surface w-fit overflow-clip rounded-sm">
            <WindowControl control="minimize" />
            <WindowControl control="maximize" data-preview="hover" />
            <WindowControl control="close" />
          </WindowControlGroup>
        </Specimen>
        <Specimen caption="Наведение на закрыть">
          <WindowControlGroup className="bg-surface w-fit overflow-clip rounded-sm">
            <WindowControl control="minimize" />
            <WindowControl control="maximize" />
            <WindowControl control="close" data-preview="hover" />
          </WindowControlGroup>
        </Specimen>
        <Specimen caption="Светофоры macOS, серые всегда">
          <div className="bg-surface flex h-14 items-center rounded-sm px-4">
            <WindowTrafficLights />
          </div>
        </Specimen>
      </div>
    </ShowcaseGroup>
  );
}

function FloatingWidget() {
  return (
    <Specimen caption="Плавающий виджет 320: скругление 26, тень плавающего, справа сверху поверх звонилки">
      {/* A stand-in desktop with the meeting app underneath */}
      <div className="relative h-[420px] w-[640px] shrink-0 overflow-clip rounded-md bg-[#E4E4E1]">
        <div className="absolute top-14 left-8 flex h-[300px] w-[400px] flex-col items-center justify-center gap-2 rounded-sm bg-[#D3D3D0]">
          <ZoomIcon className="size-7 opacity-50" />
          <span className="text-muted-foreground text-base">Zoom</span>
        </div>
        <CallWidget className="absolute top-5 right-5">
          <CallWidgetHeader>
            <CallWidgetTitle>Похоже, начался звонок</CallWidgetTitle>
            <CallWidgetDescription>
              <ZoomIcon />
              Микрофон занят Zoom
            </CallWidgetDescription>
          </CallWidgetHeader>
          <CallWidgetContent>
            <Select defaultValue="telemedia" items={PROJECT_ITEMS}>
              <CallWidgetSelectTrigger aria-label="Проект">
                <SelectValue />
              </CallWidgetSelectTrigger>
              <SelectContent>
                {PROJECTS.map((project) => (
                  <SelectItem key={project.value} value={project.value}>
                    {project.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CallWidgetPeople>
              <CallWidgetPerson initials="ОД" name="Ольга" />
              <CallWidgetPerson initials="ИС" name="Игорь" />
              <CallWidgetAddPerson />
            </CallWidgetPeople>
          </CallWidgetContent>
          <CallWidgetFooter>
            <Button className="flex-1" size="lg">
              Начать
            </Button>
            <Button size="lg" variant="ghost">
              Не сейчас
            </Button>
          </CallWidgetFooter>
        </CallWidget>
      </div>
    </Specimen>
  );
}

function WindowShell() {
  return (
    <Specimen caption="Окно: серый фон, скругление 26, шапка 56, белая панель внутри">
      <AppWindow className="h-[420px] w-[624px] shrink-0">
        <WindowTitlebar>
          <WindowTitlebarStart>
            <WindowTrafficLights />
            <WindowTitle>Grill</WindowTitle>
          </WindowTitlebarStart>
        </WindowTitlebar>
        <AppWindowBody>
          <div className="flex w-[150px] shrink-0 flex-col gap-2.5 px-2 py-3">
            <Skeleton className="h-2.5 w-[90px] animate-none" />
            <Skeleton className="h-2.5 w-[120px] animate-none" />
            <Skeleton className="h-2.5 w-[70px] animate-none" />
          </div>
          <AppWindowPanel className="gap-3 p-6">
            <div className="text-xl font-semibold tracking-tight text-balance">
              Белая панель
            </div>
            <p className="text-muted-foreground text-sm">
              Скругление 20, тень карточки, отступ 8 от краёв окна. Главный
              контент живёт здесь.
            </p>
            <div className="flex flex-col gap-2.5 pt-3">
              <Skeleton
                className="h-2.5 w-[260px] animate-none"
                tone="surface"
              />
              <Skeleton
                className="h-2.5 w-[200px] animate-none"
                tone="surface"
              />
              <Skeleton
                className="h-2.5 w-[230px] animate-none"
                tone="surface"
              />
            </div>
          </AppWindowPanel>
        </AppWindowBody>
      </AppWindow>
    </Specimen>
  );
}

function Shells() {
  return (
    <ShowcaseGroup title="Плавающий виджет и окно">
      <div className="flex flex-wrap items-start gap-12">
        <FloatingWidget />
        <WindowShell />
      </div>
    </ShowcaseGroup>
  );
}

/** Gray sidebar fill the items live on. */
function Sidebar({ children }: { children: ReactNode }) {
  return <div className="bg-surface w-60 rounded-md p-3">{children}</div>;
}

const NAV_STATES = [
  { caption: "По умолчанию" },
  { caption: "Наведение", preview: "hover" },
  { active: true, caption: "Активный: белая пилюля" },
  { caption: "Фокус с клавиатуры", preview: "focus" },
] as const;

function Navigation() {
  return (
    <ShowcaseGroup title="Пункт боковой навигации">
      <div className="flex flex-wrap items-start gap-10">
        {NAV_STATES.map((state) => (
          <Specimen caption={state.caption} key={state.caption}>
            <Sidebar>
              <NavItem
                active={"active" in state}
                data-preview={"preview" in state ? state.preview : undefined}
                href={HREF}
              >
                <ProjectsIcon />
                <NavItemLabel>Проекты</NavItemLabel>
                <Counter variant="neutral">4</Counter>
              </NavItem>
            </Sidebar>
          </Specimen>
        ))}
      </div>
      <Specimen
        caption="В сборе: идёт звонок (точка записи), ошибка интеграции иконкой «!»"
        className="pt-3"
      >
        <Sidebar>
          <NavMenu aria-label="Разделы приложения">
            <NavItem active href={HREF}>
              <PhoneIcon />
              <NavItemLabel>Звонки</NavItemLabel>
              <NavItemRecording />
            </NavItem>
            <NavItem href={HREF}>
              <ProjectsIcon />
              <NavItemLabel>Проекты</NavItemLabel>
              <Counter variant="neutral">4</Counter>
            </NavItem>
            <NavItem href={HREF}>
              <IntegrationsIcon />
              <NavItemLabel>Интеграции</NavItemLabel>
              <NavItemError aria-label="ошибка подключения" />
            </NavItem>
            <NavItem href={HREF}>
              <SettingsIcon />
              <NavItemLabel>Настройки</NavItemLabel>
            </NavItem>
          </NavMenu>
        </Sidebar>
      </Specimen>
    </ShowcaseGroup>
  );
}

export function WindowsSection() {
  return (
    <ShowcaseSection
      description="Шапки окон для macOS и Windows, плавающий виджет, белая панель внутри окна и пункты боковой навигации."
      id="windows"
      title="Окна и оболочки"
    >
      <MacTitlebars />
      <WindowsTitlebars />
      <Shells />
      <Navigation />
    </ShowcaseSection>
  );
}
