import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PlusIcon } from "@/features/shell/icons";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { FolderPlusIcon } from "../icons";
import { FIRST_RUN_STEPS, type SourceKind } from "../mock";
import { SourceTile } from "./source-mark";

/*
 * Home before the first project: a larger empty state (56px tile, 28px
 * title), three cards that explain the steps (not clickable) and the
 * "Создать проект" button.
 */
export function FirstRun({
  className,
  steps = FIRST_RUN_STEPS,
}: {
  className?: string;
  steps?: typeof FIRST_RUN_STEPS;
}) {
  return (
    <Empty className={cn("gap-10 p-12", className)}>
      <EmptyHeader className="max-w-[520px] gap-3">
        <EmptyMedia
          className="text-foreground size-14 rounded-md [&_svg:not([class*='size-'])]:size-6"
          variant="icon"
        >
          <FolderPlusIcon />
        </EmptyMedia>
        <EmptyTitle className="pt-2 text-2xl tracking-tight text-balance">
          <h1>Начнём с первого проекта</h1>
        </EmptyTitle>
        <EmptyDescription className="text-lg text-pretty">
          Grill соберёт бриф из документов и кода, запомнит людей клиента и на
          звонке будет подсказывать вопросы именно по этому проекту.
        </EmptyDescription>
      </EmptyHeader>
      <ol className="flex w-[760px] gap-4 text-left text-wrap">
        {steps.map((step, index) => (
          <FirstRunStep
            description={step.description}
            key={step.title}
            number={index + 1}
            title={step.title}
          >
            {step.sources ? <SourceTiles kinds={step.sources} /> : null}
          </FirstRunStep>
        ))}
      </ol>
      <EmptyContent className="gap-3">
        <Button
          className="pr-5 pl-4"
          {...linkButtonProps(routes.newProject())}
          size="lg"
        >
          <PlusIcon className="size-3.5" />
          Создать проект
        </Button>
        <p className="text-muted-foreground text-sm">
          Займёт пару минут. Бриф агент соберёт в фоне.
        </p>
      </EmptyContent>
    </Empty>
  );
}

function FirstRunStep({
  children,
  description,
  number,
  title,
}: {
  children?: ReactNode;
  description: string;
  number: number;
  title: string;
}) {
  return (
    <li className="bg-surface flex flex-1 flex-col gap-2 rounded-md p-5">
      <span className="text-muted-foreground font-mono text-xs">{number}</span>
      <h2 className="text-foreground text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      {children}
    </li>
  );
}

function SourceTiles({ kinds }: { kinds: SourceKind[] }) {
  return (
    <span className="flex gap-1.5 pt-1">
      {kinds.map((kind) => (
        <SourceTile
          className="bg-background"
          key={kind}
          kind={kind}
          size="sm"
        />
      ))}
    </span>
  );
}
