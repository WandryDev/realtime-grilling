"use client";

// Client module: the class constants below come from "use client" ui files
// and are only real values inside another client module.

import { type ReactNode, useId } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogSurfaceClassName,
  dialogTitleClassName,
} from "@/components/ui/alert-dialog";
import {
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  ToastIcon,
  toastContentClassName,
  toastSurfaceClassName,
  toastTitleClassName,
} from "@/components/ui/toast";
import type { IntegrationService } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { CheckIcon } from "../icons";
import {
  DISCONNECT_CLICKUP,
  DISCONNECT_GITHUB,
  DISCONNECT_OUTLINE,
  type DisconnectContent,
} from "../mock";

/*
 * What is drawn over the integrations window: the "Отключить GitHub?"
 * confirmation and the undo toast after it. The /dev/screens previews draw
 * them in place (DisconnectServiceDialog, ServiceDisconnectedToast); the app
 * opens the same body in a real AlertDialog (DisconnectServiceAlertDialog)
 * and shows the toast through the Toaster.
 */

export const DISCONNECT_CONTENT: Record<IntegrationService, DisconnectContent> =
  {
    clickup: DISCONNECT_CLICKUP,
    github: DISCONNECT_GITHUB,
    outline: DISCONNECT_OUTLINE,
  };

const SERVICE_ICONS: Record<IntegrationService, ReactNode> = {
  clickup: <ClickUpIcon className="size-5" />,
  github: <GitHubIcon className="size-5" />,
  outline: <OutlineIcon className="size-5" />,
};

/**
 * Logo tile, title and description, the consequences list and the footnote.
 * `title` and `description` come wrapped by the caller (plain headings in
 * the preview, AlertDialog parts in the app).
 */
function DisconnectServiceBody({
  consequences,
  description,
  footnote,
  service,
  title,
}: {
  consequences: string[];
  description: ReactNode;
  footnote: string;
  service: IntegrationService;
  title: ReactNode;
}) {
  return (
    <>
      <span className="bg-surface ring-foreground/6 flex size-11 items-center justify-center rounded-sm ring-1">
        {SERVICE_ICONS[service]}
      </span>
      <div className={dialogHeaderClassName}>
        {title}
        {description}
      </div>
      <ul className="bg-surface flex flex-col rounded-md px-4 py-1">
        {consequences.map((item) => (
          <li
            className="border-border flex items-center gap-2.5 border-b py-2.5 text-base last:border-b-0"
            key={item}
          >
            <CheckIcon className="text-confirmed size-4 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">{footnote}</p>
    </>
  );
}

/** "Отключить GitHub?" over a 20% ink scrim, centered in the window. */
export function DisconnectServiceDialog({
  className,
  content = DISCONNECT_GITHUB,
  service = "github",
}: {
  className?: string;
  content?: DisconnectContent;
  service?: IntegrationService;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  return (
    <div
      className={cn(
        "bg-foreground/20 absolute inset-0 z-10 flex items-center justify-center",
        className
      )}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(dialogSurfaceClassName, "w-120 p-7")}
        role="alertdialog"
      >
        <DisconnectServiceBody
          consequences={content.consequences}
          description={
            <p className={dialogDescriptionClassName} id={descriptionId}>
              {content.description}
            </p>
          }
          footnote={content.footnote}
          service={service}
          title={
            <h2 className={dialogTitleClassName} id={titleId}>
              {content.title}
            </h2>
          }
        />
        <div className={cn(dialogFooterClassName, "pt-1")}>
          <Button variant="secondary">Отмена</Button>
          <Button variant="destructive">Отключить</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The live confirmation. `service` is the service to disconnect, `null`
 * keeps the dialog closed.
 */
export function DisconnectServiceAlertDialog({
  contents,
  onConfirm,
  onOpenChange,
  service,
}: {
  /** Texts that differ from the defaults (Outline names its projects). */
  contents?: Partial<Record<IntegrationService, DisconnectContent>>;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  service: IntegrationService | null;
}) {
  // Keep the last content while the dialog animates out.
  const shown = service ?? "github";
  const content = contents?.[shown] ?? DISCONNECT_CONTENT[shown];
  return (
    <AlertDialog onOpenChange={onOpenChange} open={service !== null}>
      <AlertDialogContent className="p-7 sm:max-w-120">
        <DisconnectServiceBody
          consequences={content.consequences}
          description={
            <AlertDialogDescription>
              {content.description}
            </AlertDialogDescription>
          }
          footnote={content.footnote}
          service={shown}
          title={<AlertDialogTitle>{content.title}</AlertDialogTitle>}
        />
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            Отключить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Undo toast at the bottom of the panel: "GitHub отключён" · "Вернуть". */
export function ServiceDisconnectedToast({
  className,
  title = "GitHub отключён",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={cn(
        toastSurfaceClassName,
        toastContentClassName,
        "h-12 w-86 py-0 pr-2",
        className
      )}
      role="status"
    >
      <ToastIcon type="success" />
      <p className={toastTitleClassName}>{title}</p>
      <Button data-slot="toast-action" variant="secondary">
        Вернуть
      </Button>
    </div>
  );
}
