import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SearchInput } from "@/components/ui/search-input";

describe("PasswordInput", () => {
  it("masks the value until the eye is pressed", async () => {
    render(<PasswordInput aria-label="Ключ Outline" defaultValue="ol_7Hq2" />);

    const input = screen.getByLabelText("Ключ Outline");
    expect(input.getAttribute("type")).toBe("password");

    await userEvent.click(
      screen.getByRole("button", { name: "Показать ключ" })
    );

    expect(input.getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Скрыть ключ" })).toBeDefined();
  });
});

describe("Field", () => {
  it("links the label, hint and error to the control", () => {
    render(
      <Field>
        <FieldLabel>Название проекта</FieldLabel>
        <Input defaultValue="Ветклиника Лапа" />
        <FieldDescription>Видно в списке звонков</FieldDescription>
        <FieldError>Такой проект уже есть</FieldError>
      </Field>
    );

    const input = screen.getByLabelText("Название проекта");
    const hint = screen.getByText("Видно в списке звонков");
    const error = screen.getByRole("alert");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby")?.split(" ");
    expect(describedBy).toContain(hint.id);
    expect(describedBy).toContain(error.id);
    expect(error.textContent).toBe("Такой проект уже есть");
  });

  it("leaves a valid control unmarked", () => {
    render(
      <Field>
        <FieldLabel>Название проекта</FieldLabel>
        <Input defaultValue="Телемедиа" />
      </Field>
    );

    const input = screen.getByLabelText("Название проекта");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("SearchInput", () => {
  it("clears the query with the clear button", async () => {
    const onClear = vi.fn();
    render(
      <SearchInput
        aria-label="Поиск по звонкам"
        defaultValue="amoCRM"
        onClear={onClear}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Поиск по звонкам" });
    await userEvent.click(
      screen.getByRole("button", { name: "Очистить поиск" })
    );

    expect((input as HTMLInputElement).value).toBe("");
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Очистить поиск" })).toBeNull();
    expect(document.activeElement).toBe(input);
  });
});
