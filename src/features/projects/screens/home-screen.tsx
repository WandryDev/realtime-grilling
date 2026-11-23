import { Button } from "@grill/ui/button";
import { useId } from "react";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { PlusIcon } from "@/features/shell/icons";
import {
  MainWindow,
  PageContent,
  PageHeader,
  TitlebarSearch,
} from "@/features/shell/main-window";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CallLineList } from "../components/call-line";
import { FirstRun } from "../components/first-run";
import { ProjectsTable } from "../components/projects-table";
import { SectionHeading } from "../components/section-heading";
import {
  type CallSummary,
  HOME_PROJECTS,
  type HomeProject,
  RECENT_CALLS,
} from "../mock";

/*
 * 01 Главная: the projects table and the recent calls.
 * 02 Главная, первый запуск (`state="first-run"`): no projects yet.
 * The sidebar lists the user's projects from the store (none on first run).
 */
export function HomeScreen({
  calls = RECENT_CALLS,
  className,
  greeting = "Добрый день, Дима",
  projects = HOME_PROJECTS,
  state = "projects",
}: {
  calls?: CallSummary[];
  className?: string;
  greeting?: string;
  projects?: HomeProject[];
  state?: "projects" | "first-run";
}) {
  const isFirstRun = state === "first-run";
  const recentCallsId = useId();

  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      panelClassName={cn(isFirstRun && "justify-center-safe")}
      sidebar={
        <MainSidebar active="home" projects={isFirstRun ? [] : undefined} />
      }
    >
      {isFirstRun ? (
        <FirstRun />
      ) : (
        <PageContent>
          <PageHeader
            actions={
              <Button
                className="h-9 pr-4 pl-3"
                {...linkButtonProps(routes.newProject())}
              >
                <PlusIcon className="size-3.5" />
                Новый проект
              </Button>
            }
            eyebrow={greeting}
            title="Проекты"
          />
          <ProjectsTable projects={projects} />
          <section
            aria-labelledby={recentCallsId}
            className="flex flex-col gap-2"
          >
            <SectionHeading
              action={
                <Button
                  className="-mx-2 -my-1.5 px-2"
                  {...linkButtonProps(routes.history())}
                  size="sm"
                  variant="ghost"
                >
                  Вся история
                </Button>
              }
              className="items-baseline px-4"
              id={recentCallsId}
              size="lg"
              title="Недавние звонки"
            />
            <CallLineList calls={calls} empty="Звонков пока не было" />
          </section>
        </PageContent>
      )}
    </MainWindow>
  );
}
