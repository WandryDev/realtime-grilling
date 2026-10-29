import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";
import { ChoiceField, ChoiceFieldLabel } from "@/components/ui/choice-field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  SettingRow,
  SettingRowContent,
  SettingRowControl,
  SettingRowDescription,
  SettingRowTitle,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";

describe("Checkbox in a ChoiceField", () => {
  it("toggles when the label text is clicked", async () => {
    render(
      <ChoiceField>
        <Checkbox />
        <ChoiceFieldLabel>Ольга Демченко</ChoiceFieldLabel>
      </ChoiceField>
    );
    const checkbox = screen.getByRole("checkbox", { name: "Ольга Демченко" });

    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(screen.getByText("Ольга Демченко"));
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByText("Ольга Демченко"));
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("ignores clicks when disabled", async () => {
    const onCheckedChange = vi.fn();
    render(
      <ChoiceField>
        <Checkbox disabled onCheckedChange={onCheckedChange} />
        <ChoiceFieldLabel>Ольга Демченко</ChoiceFieldLabel>
      </ChoiceField>
    );

    await userEvent.click(screen.getByText("Ольга Демченко"));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("RadioGroup", () => {
  it("selects the option whose label is clicked", async () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Язык звонка" onValueChange={onValueChange}>
        <ChoiceField>
          <RadioGroupItem value="uk" />
          <ChoiceFieldLabel>Украинский</ChoiceFieldLabel>
        </ChoiceField>
        <ChoiceField>
          <RadioGroupItem value="ru" />
          <ChoiceFieldLabel>Русский</ChoiceFieldLabel>
        </ChoiceField>
      </RadioGroup>
    );

    await userEvent.click(screen.getByText("Русский"));

    expect(onValueChange.mock.calls[0]?.[0]).toBe("ru");
    expect(
      screen
        .getByRole("radio", { name: "Русский" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });
});

describe("Switch", () => {
  it("toggles on click and from its row label", async () => {
    render(
      <ChoiceField>
        <Switch />
        <ChoiceFieldLabel>Автостарт</ChoiceFieldLabel>
      </ChoiceField>
    );
    const toggle = screen.getByRole("switch", { name: "Автостарт" });

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByText("Автостарт"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("SettingRow", () => {
  it("toggles the switch when the title is clicked", async () => {
    render(
      <SettingRow>
        <SettingRowContent>
          <SettingRowTitle htmlFor="autostart">
            Начинать при включении микрофона
          </SettingRowTitle>
          <SettingRowDescription>
            Покажем виджет, звонок стартует по кнопке
          </SettingRowDescription>
        </SettingRowContent>
        <SettingRowControl>
          <Switch id="autostart" />
        </SettingRowControl>
      </SettingRow>
    );

    expect(
      screen.getByRole("group", { name: "Начинать при включении микрофона" })
    ).toBeDefined();
    const toggle = screen.getByRole("switch");
    await userEvent.click(screen.getByText("Начинать при включении микрофона"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("SegmentedControl", () => {
  function renderSegments(onValueChange = vi.fn()) {
    render(
      <SegmentedControl
        aria-label="Какие вопросы показать"
        defaultValue="all"
        onValueChange={onValueChange}
      >
        <SegmentedControlItem value="all">Все</SegmentedControlItem>
        <SegmentedControlItem value="open">Открытые</SegmentedControlItem>
      </SegmentedControl>
    );
    return onValueChange;
  }

  it("changes the selected segment", async () => {
    const onValueChange = renderSegments();

    await userEvent.click(screen.getByRole("button", { name: "Открытые" }));

    expect(onValueChange).toHaveBeenCalledWith("open");
    expect(
      screen
        .getByRole("button", { name: "Открытые" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Все" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("keeps a segment selected when the selected one is clicked again", async () => {
    const onValueChange = renderSegments();

    await userEvent.click(screen.getByRole("button", { name: "Все" }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Все" }).getAttribute("aria-pressed")
    ).toBe("true");
  });
});

describe("Tabs as a filter", () => {
  it("switches the active tab and shows counters in the name", async () => {
    render(
      <Tabs defaultValue="all">
        <TabsList aria-label="Фильтр проектов" size="sm">
          <TabsTrigger value="all">
            Все <TabsCount>6</TabsCount>
          </TabsTrigger>
          <TabsTrigger value="open">
            С открытыми вопросами <TabsCount tone="accent">3</TabsCount>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );
    const open = screen.getByRole("tab", { name: "С открытыми вопросами 3" });

    await userEvent.click(open);

    expect(open.getAttribute("aria-selected")).toBe("true");
  });
});
