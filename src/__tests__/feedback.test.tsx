import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grill/ui/alert";
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
} from "@grill/ui/alert-dialog";
import { Button } from "@grill/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grill/ui/dropdown-menu";
import { createToastManager, Toaster } from "@grill/ui/toast";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackSection } from "@/app/dev/_sections/feedback";

describe("AlertDialog", () => {
  it("opens from its trigger and runs the confirm handler", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="secondary" />}>
          Удалить звонок
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить звонок от 19 октября?</AlertDialogTitle>
            <AlertDialogDescription>
              Пропадут запись, расшифровка и итоги.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm} variant="destructive">
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Удалить звонок" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить звонок от 19 октября?",
    });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Alert", () => {
  it("renders the banner action as a button and announces errors", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Агент не отвечает</AlertTitle>
        <AlertDescription>Claude Code упал.</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="secondary">
            Перезапустить
          </Button>
        </AlertAction>
      </Alert>
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Агент не отвечает"
    );
    expect(screen.getByRole("button", { name: "Перезапустить" })).toBeDefined();
  });

  it("keeps calm banners out of the assertive alert role", () => {
    render(
      <Alert>
        <AlertTitle>ClickUp не подключён</AlertTitle>
      </Alert>
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });
});

describe("DropdownMenu", () => {
  it("renders the destructive item as a menuitem at the bottom", async () => {
    const user = userEvent.setup();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button aria-label="Действия с вопросом" size="icon" />}
        />
        <DropdownMenuContent>
          <DropdownMenuItem>Закрепить</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            Убрать из итогов
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(
      screen.getByRole("button", { name: "Действия с вопросом" })
    );

    const items = await screen.findAllByRole("menuitem");
    const last = items.at(-1);
    expect(last?.textContent).toBe("Убрать из итогов");
    expect(last?.getAttribute("data-variant")).toBe("destructive");
  });
});

describe("Toaster", () => {
  it("announces toasts in a polite live region", async () => {
    const manager = createToastManager();
    render(<Toaster toastManager={manager} />);

    act(() => {
      manager.add({ title: "Бриф Телемедиа обновлён", type: "success" });
    });

    const region = screen.getByRole("region");
    expect(region.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => {
      expect(region.textContent).toContain("Бриф Телемедиа обновлён");
    });
  });

  it("shows the undo action and hides the cross on a success toast", async () => {
    const manager = createToastManager();
    render(<Toaster toastManager={manager} />);

    act(() => {
      manager.add({
        actionProps: { children: "Вернуть" },
        title: "Бриф Телемедиа обновлён",
        type: "success",
      });
    });

    expect(
      await screen.findByRole("button", { name: "Вернуть" })
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
  });
});

describe("FeedbackSection", () => {
  it("draws every overlay in place without opening one", () => {
    render(<FeedbackSection />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Обратная связь" })
    ).toBeDefined();
    expect(screen.getByText("Почему агент так думает")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
