"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  EllipsisIcon,
  InfoIcon,
  MicIcon,
  PinIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogSurfaceClassName,
  dialogTitleClassName,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  menuItemClassName,
  menuPopupClassName,
  menuSeparatorClassName,
  menuShortcutClassName,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverFooter,
  PopoverQuote,
  PopoverTitle,
  PopoverTrigger,
  popoverDescriptionClassName,
  popoverSurfaceClassName,
  popoverTitleClassName,
} from "@/components/ui/popover";
import {
  Progress,
  ProgressCaption,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { AgentStatus } from "@/components/ui/recording-indicator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  createToastManager,
  Toaster,
  ToastIcon,
  type ToastType,
  toastActionClassName,
  toastCloseClassName,
  toastContentClassName,
  toastSurfaceClassName,
  toastTitleClassName,
} from "@/components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  tooltipSurfaceClassName,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
} from "../_components/showcase";

/*
 * Paper "09 Обратная связь". Toasts, the dialog, the popover, the tooltip and
 * the menu are drawn in place from the same class constants as the real
 * components, so every state is visible without floating over the page or
 * taking focus. Each group ends with a live example that opens the real thing.
 */

// Local manager: the live toasts of this section, independent of any app-wide Toaster.
const feedbackToasts = createToastManager();

const CALL_TITLE = "Удалить звонок от 19 октября?";
const CALL_TEXT =
  "Пропадут запись, расшифровка и итоги. Обновления брифа, которые вы уже приняли, останутся.";

const WHY_TITLE = "Почему агент так думает";
const WHY_TEXT =
  "Клиент сказал «он же у всех есть» про номер телефона. В базе пациентов это никто не проверял.";
const WHY_QUOTE = "«Карточку, наверное, по номеру будем искать»";

const MENU_ITEMS = [
  { icon: PinIcon, label: "Закрепить", shortcut: "⌘P" },
  { icon: CheckIcon, label: "Уже спросил", shortcut: "⌘D" },
  { icon: XIcon, label: "Скрыть", shortcut: "⌘H" },
] as const;

function SpecimenRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-12">{children}</div>;
}

/* ---------------------------------------------------------------- Тост */

function ToastPreview({
  action,
  className,
  closable = false,
  title,
  type,
}: {
  action?: { label: string; variant: "ghost" | "secondary" };
  className?: string;
  closable?: boolean;
  title: string;
  type: ToastType;
}) {
  return (
    <div
      className={cn(toastSurfaceClassName, toastContentClassName, className)}
      inert
    >
      <ToastIcon type={type} />
      <p className={toastTitleClassName}>{title}</p>
      {action ? (
        <Button
          className={toastActionClassName}
          data-slot="toast-action"
          size="sm"
          variant={action.variant}
        >
          {action.label}
        </Button>
      ) : null}
      {closable ? (
        <Button
          aria-label="Закрыть"
          className={toastCloseClassName}
          data-slot="toast-close"
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden strokeWidth={2.4} />
        </Button>
      ) : null}
    </div>
  );
}

function showSuccessToast() {
  const id = feedbackToasts.add({
    actionProps: {
      children: "Вернуть",
      onClick: () => feedbackToasts.close(id),
    },
    title: "Бриф Телемедиа обновлён",
    type: "success",
  });
}

function showErrorToast() {
  const id = feedbackToasts.add({
    actionProps: {
      children: "Повторить",
      onClick: () => feedbackToasts.close(id),
    },
    priority: "high",
    // Errors wait for the user
    timeout: 0,
    title: "Не удалось сохранить итоги",
    type: "error",
  });
}

function showInfoToast() {
  feedbackToasts.add({
    title: "Окно скрыто от демонстрации экрана",
    type: "info",
  });
}

function ToastGroup() {
  return (
    <ShowcaseGroup title="Тост">
      <div className="flex flex-wrap items-start gap-10">
        <Specimen caption="Успех, с отменой">
          <ToastPreview
            action={{ label: "Вернуть", variant: "ghost" }}
            className="w-[380px]"
            title="Бриф Телемедиа обновлён"
            type="success"
          />
        </Specimen>
        <Specimen caption="Ошибка, с повтором">
          <ToastPreview
            action={{ label: "Повторить", variant: "secondary" }}
            className="w-fit"
            closable
            title="Не удалось сохранить итоги"
            type="error"
          />
        </Specimen>
        <Specimen caption="Информация, закрывается крестиком">
          <ToastPreview
            className="w-[380px]"
            closable
            title="Окно скрыто от демонстрации экрана"
            type="info"
          />
        </Specimen>
      </div>
      <Specimen caption="Живой пример: тосты появляются в правом нижнем углу">
        <div className="flex flex-wrap gap-2">
          <Button onClick={showSuccessToast} variant="secondary">
            Успех
          </Button>
          <Button onClick={showErrorToast} variant="secondary">
            Ошибка
          </Button>
          <Button onClick={showInfoToast} variant="secondary">
            Информация
          </Button>
        </div>
      </Specimen>
    </ShowcaseGroup>
  );
}

/* ------------------------------------------------------ Баннер в панели */

function BannerRow({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex flex-wrap items-center gap-x-12 gap-y-3">
      <div className="w-full max-w-[720px] shrink-0">{children}</div>
      <figcaption className="text-muted-foreground text-sm">
        {caption}
      </figcaption>
    </figure>
  );
}

function BannerGroup() {
  return (
    <ShowcaseGroup title="Баннер в панели">
      <div className="flex flex-col gap-4">
        <BannerRow caption="Информация, серый">
          <Alert>
            <InfoIcon />
            <AlertTitle>ClickUp не подключён</AlertTitle>
            <AlertDescription>
              Вопросы из задач не появятся. Звонок работает и без этого.
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="secondary">
                Подключить
              </Button>
            </AlertAction>
          </Alert>
        </BannerRow>
        <BannerRow caption="Внимание, мягкий оранжевый">
          <Alert variant="warning">
            <CircleAlertIcon />
            <AlertTitle>Разговор идёт к концу, проверьте важное</AlertTitle>
            <AlertDescription>
              3 незакрытых вопроса по прошлым темам
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="secondary">
                Показать
              </Button>
            </AlertAction>
          </Alert>
        </BannerRow>
        <BannerRow caption="Ошибка, мягкий красный">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Агент не отвечает</AlertTitle>
            <AlertDescription>
              Claude Code упал. Расшифровка пишется, вопросы появятся после
              перезапуска.
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="secondary">
                Перезапустить
              </Button>
            </AlertAction>
          </Alert>
        </BannerRow>
      </div>
    </ShowcaseGroup>
  );
}

/* ----------------------------------------------------- Диалог и поповер */

function DialogPreview() {
  return (
    <div
      className="bg-foreground/16 flex h-[340px] w-[620px] max-w-full items-center justify-center rounded-md"
      inert
    >
      <div className={cn(dialogSurfaceClassName, "w-[420px]")}>
        <div className={dialogHeaderClassName}>
          <p className={dialogTitleClassName}>{CALL_TITLE}</p>
          <p className={dialogDescriptionClassName}>{CALL_TEXT}</p>
        </div>
        <div className={dialogFooterClassName}>
          <Button variant="secondary">Отмена</Button>
          <Button variant="destructive">Удалить</Button>
        </div>
      </div>
    </div>
  );
}

function PopoverPreview() {
  return (
    <div
      className="bg-surface flex h-[340px] w-[420px] max-w-full flex-col items-start gap-2 rounded-md p-7"
      inert
    >
      <Badge
        className="shadow-[0_0_0_2px_var(--color-background)]"
        variant="assumption"
      >
        допущение
      </Badge>
      <div className={popoverSurfaceClassName}>
        <p className={popoverTitleClassName}>{WHY_TITLE}</p>
        <p className={popoverDescriptionClassName}>{WHY_TEXT}</p>
        <PopoverQuote time="12:23">{WHY_QUOTE}</PopoverQuote>
        <PopoverFooter>
          <Button size="sm" variant="secondary">
            Уже проверено
          </Button>
        </PopoverFooter>
      </div>
    </div>
  );
}

function DeleteCallDemo() {
  const [open, setOpen] = useState(false);

  const deleteCall = useCallback(() => {
    setOpen(false);
    feedbackToasts.add({ title: "Звонок удалён", type: "success" });
  }, []);

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={<Button className="self-start" variant="secondary" />}
      >
        Удалить звонок
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{CALL_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{CALL_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={deleteCall} variant="destructive">
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function WhyPopoverDemo() {
  return (
    <Popover>
      <PopoverTrigger
        className="cursor-pointer data-popup-open:shadow-[0_0_0_2px_var(--color-background)]"
        render={
          <Badge render={<button type="button" />} variant="assumption" />
        }
      >
        допущение
      </PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>{WHY_TITLE}</PopoverTitle>
        <PopoverDescription>{WHY_TEXT}</PopoverDescription>
        <PopoverQuote time="12:23">{WHY_QUOTE}</PopoverQuote>
        <PopoverFooter>
          <PopoverClose render={<Button size="sm" variant="secondary" />}>
            Уже проверено
          </PopoverClose>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
}

function OverlayGroup() {
  return (
    <ShowcaseGroup title="Диалог и поповер">
      <SpecimenRow>
        <Specimen caption="Подтверждение опасного действия. Скругление 26, затемнение фона">
          <DialogPreview />
        </Specimen>
        <Specimen caption="Поповер по клику на метку: объяснение и цитата">
          <PopoverPreview />
        </Specimen>
      </SpecimenRow>
      <SpecimenRow>
        <Specimen caption="Живой пример: настоящий диалог подтверждения">
          <DeleteCallDemo />
        </Specimen>
        <Specimen caption="Живой пример: нажмите на метку">
          <div className="bg-surface flex h-8 items-center self-start rounded-full px-3">
            <WhyPopoverDemo />
          </div>
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

/* ----------------------------------------------------- Подсказка и меню */

function TooltipPreview() {
  return (
    <div
      className="bg-surface flex w-[280px] flex-col items-center gap-2 rounded-md px-5 py-10"
      inert
    >
      <div className={tooltipSurfaceClassName} data-slot="tooltip-content">
        Скрыть вопрос
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>H</Kbd>
        </KbdGroup>
      </div>
      <Button
        aria-label="Скрыть вопрос"
        data-preview="hover"
        size="icon"
        variant="secondary"
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

function MenuPreview() {
  return (
    <div
      className="bg-surface flex w-[340px] flex-col items-end gap-2 rounded-md p-5"
      inert
    >
      <Button
        aria-label="Действия с вопросом"
        data-preview="hover"
        size="icon"
        variant="secondary"
      >
        <EllipsisIcon aria-hidden />
      </Button>
      <div className={cn(menuPopupClassName, "flex w-[260px] flex-col")}>
        {MENU_ITEMS.map(({ icon: Icon, label, shortcut }, index) => (
          <div
            className={menuItemClassName}
            data-highlighted={index === 0 ? "" : undefined}
            key={label}
          >
            <Icon aria-hidden />
            <span className="flex-1">{label}</span>
            <span className={menuShortcutClassName}>{shortcut}</span>
          </div>
        ))}
        <div className={menuSeparatorClassName} />
        <div className={menuItemClassName}>
          <CopyIcon aria-hidden />
          <span className="flex-1">Скопировать текст</span>
        </div>
        <div className={menuItemClassName} data-variant="destructive">
          <Trash2Icon aria-hidden />
          <span className="flex-1">Убрать из итогов</span>
        </div>
      </div>
    </div>
  );
}

function HideQuestionTooltipDemo() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Скрыть вопрос"
              size="icon"
              variant="secondary"
            />
          }
        >
          <XIcon aria-hidden />
        </TooltipTrigger>
        <TooltipContent>
          Скрыть вопрос
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>H</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function QuestionMenuDemo() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Действия с вопросом"
            size="icon"
            variant="secondary"
          />
        }
      >
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        {MENU_ITEMS.map(({ icon: Icon, label, shortcut }) => (
          <DropdownMenuItem key={label}>
            <Icon aria-hidden />
            {label}
            <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <CopyIcon aria-hidden />
          Скопировать текст
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive">
          <Trash2Icon aria-hidden />
          Убрать из итогов
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoCallsEmpty() {
  return (
    <Empty className="w-[400px] max-w-full flex-none">
      <EmptyMedia variant="icon">
        <MicIcon strokeWidth={1.5} />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Звонков пока не было</EmptyTitle>
        <EmptyDescription>
          Когда включится микрофон, Grill предложит начать. Можно и вручную.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Начать звонок</Button>
      </EmptyContent>
    </Empty>
  );
}

function MenuGroup() {
  return (
    <ShowcaseGroup title="Подсказка и меню">
      <SpecimenRow>
        <Specimen caption="Подсказка: чёрная, с клавишами">
          <TooltipPreview />
        </Specimen>
        <Specimen caption="Меню: пункт под курсором серый, опасный красным внизу">
          <MenuPreview />
        </Specimen>
        <Specimen caption="Пустое состояние: иконка, заголовок, пояснение, одно действие">
          <NoCallsEmpty />
        </Specimen>
      </SpecimenRow>
      <SpecimenRow>
        <Specimen caption="Живой пример: наведите или сфокусируйте">
          <HideQuestionTooltipDemo />
        </Specimen>
        <Specimen caption="Живой пример: меню с клавиатуры и мышью">
          <QuestionMenuDemo />
        </Specimen>
      </SpecimenRow>
    </ShowcaseGroup>
  );
}

/* -------------------------------------------------- Загрузка и прогресс */

function QuestionsSkeleton() {
  return (
    <div className="flex w-[400px] flex-col gap-7 px-7 py-[18px]">
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3.5 w-80" />
        <Skeleton className="h-3.5 w-[220px]" />
        <Skeleton className="h-2.5 w-[180px]" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3.5 w-[280px]" />
        <Skeleton className="h-2.5 w-[200px]" />
      </div>
    </div>
  );
}

function ContextCardSkeleton() {
  return (
    <div className="bg-surface w-80 rounded-md px-2 py-3">
      <div className="bg-background shadow-card-sm flex flex-col gap-3 rounded-md p-3.5">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-xs" tone="surface" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-20" tone="surface" />
            <Skeleton className="h-2 w-[120px]" tone="surface" />
          </div>
        </div>
        <Skeleton className="h-2.5 w-60" tone="surface" />
        <Skeleton className="h-2.5 w-[190px]" tone="surface" />
        <Skeleton className="h-[38px] rounded-sm" tone="surface" />
      </div>
    </div>
  );
}

function Spinners() {
  return (
    <div className="flex h-[120px] items-center gap-7 px-2">
      <Spinner />
      <Spinner className="size-5" />
      <Spinner className="size-7" />
      {/* Dots only, as in Paper; the word stays for screen readers */}
      <AgentStatus className="[&>span:last-child]:sr-only" state="listening" />
    </div>
  );
}

function LoadingGroup() {
  return (
    <ShowcaseGroup title="Загрузка и прогресс">
      <SpecimenRow>
        <Specimen caption="Скелетон вопросов: серые полосы по ритму строк">
          <QuestionsSkeleton />
        </Specimen>
        <Specimen caption="Скелетон карточки контекста">
          <ContextCardSkeleton />
        </Specimen>
        <Specimen caption="Спиннер 14, 20, 28 и точки «слушаю»">
          <Spinners />
        </Specimen>
      </SpecimenRow>
      <div className="flex flex-wrap items-start gap-12 pt-4">
        <Specimen caption="Прогресс: оранжевая полоса, процент моноширинным">
          <div className="flex w-[400px] flex-col gap-2.5">
            <Progress tone="active" value={62}>
              <ProgressLabel>Скачиваю модель речи</ProgressLabel>
              <ProgressValue />
            </Progress>
            <ProgressCaption>
              <span>Whisper large-v3-turbo, 1,0 из 1,6 ГБ</span>
              <span>ещё 2 мин</span>
            </ProgressCaption>
          </div>
        </Specimen>
        <Specimen caption="Прогресс прерван: полоса серая">
          <div className="flex w-[400px] flex-col gap-2.5">
            <Progress tone="paused" value={62}>
              <ProgressLabel>Загрузка на паузе</ProgressLabel>
              <ProgressValue />
            </Progress>
            <ProgressCaption>
              <span className="text-destructive">
                Пропал интернет, продолжим сами
              </span>
              <Button
                className="text-foreground -mx-2 -my-[5px] px-2"
                size="sm"
                variant="ghost"
              >
                Повторить
              </Button>
            </ProgressCaption>
          </div>
        </Specimen>
        <Specimen caption="Готово: полоса зелёная">
          <div className="flex w-[400px] flex-col gap-2.5">
            <Progress tone="done" value={100}>
              <ProgressLabel>Модель речи готова</ProgressLabel>
              <ProgressValue />
            </Progress>
            <ProgressCaption>
              <span>1,6 ГБ, хранится на этом компьютере</span>
            </ProgressCaption>
          </div>
        </Specimen>
      </div>
    </ShowcaseGroup>
  );
}

export function FeedbackSection() {
  return (
    <Toaster toastManager={feedbackToasts}>
      <ShowcaseSection
        description="Тосты, баннеры, диалоги, подсказки, меню, пустые состояния, загрузка и прогресс."
        id="feedback"
        title="Обратная связь"
      >
        <ToastGroup />
        <BannerGroup />
        <OverlayGroup />
        <MenuGroup />
        <LoadingGroup />
      </ShowcaseSection>
    </Toaster>
  );
}
