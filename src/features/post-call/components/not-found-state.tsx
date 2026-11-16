"use client";

import { MainWindow } from "@/features/shell/main-window";

import { SearchIcon } from "../icons";
import { CenteredState } from "./centered-state";
import { LinkButton } from "./link-button";

/*
 * A call or a project from a stale link: the window says so and offers the
 * way home instead of an empty screen.
 */
export function NotFoundState({
  className,
  description,
  homeHref,
  title,
}: {
  className?: string;
  description: string;
  homeHref: string;
  title: string;
}) {
  return (
    <MainWindow className={className}>
      <CenteredState
        className="flex-1"
        description={description}
        media={<SearchIcon className="size-6" />}
        mediaClassName="size-14 rounded-md"
        title={title}
      >
        <LinkButton href={homeHref} size="lg">
          На главную
        </LinkButton>
      </CenteredState>
    </MainWindow>
  );
}
