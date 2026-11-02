import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { MainWindow, TitlebarSearch } from "@/features/shell/main-window";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { FolderPlusIcon } from "../icons";

/**
 * A project or person that isn't there (deleted, or a stale link): an empty
 * state in the main window with the way back.
 */
export function MissingEntity({
  backHref = routes.home(),
  backLabel = "На главную",
  className,
  description,
  title,
}: {
  backHref?: string;
  backLabel?: string;
  className?: string;
  description: string;
  title: string;
}) {
  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      panelClassName={cn("justify-center")}
      sidebar={<MainSidebar />}
      title={title}
    >
      <Empty>
        <EmptyMedia variant="icon">
          <FolderPlusIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            <h1>{title}</h1>
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button nativeButton={false} render={<Link href={backHref} />}>
            {backLabel}
          </Button>
        </EmptyContent>
      </Empty>
    </MainWindow>
  );
}
