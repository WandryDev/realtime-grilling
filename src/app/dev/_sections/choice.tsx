import { Checkbox } from "@grill/ui/checkbox";
import {
  ChoiceField,
  ChoiceFieldLabel,
  ChoiceFieldMeta,
} from "@grill/ui/choice-field";
import { RadioGroup, RadioGroupItem } from "@grill/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@grill/ui/segmented-control";
import {
  SettingList,
  SettingRow,
  SettingRowContent,
  SettingRowControl,
  SettingRowDescription,
  SettingRowTitle,
} from "@grill/ui/setting-row";
import { Switch } from "@grill/ui/switch";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@grill/ui/tabs";
import type { ComponentType } from "react";
import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
  StateCell,
  StateRow,
  StateTable,
} from "../_components/showcase";

const STATE_COLUMNS = [
  "Выключено",
  "Включено",
  "Наведение",
  "Фокус",
  "Отключено, выкл",
  "Отключено, вкл",
];

type Preview = "hover" | "focus";

interface ChoiceState {
  checked: boolean;
  disabled?: boolean;
  id: string;
  preview?: Preview;
}

/* One entry per column of the state matrix, in the same order */
const STATES: ChoiceState[] = [
  { checked: false, id: "off" },
  { checked: true, id: "on" },
  { checked: false, id: "hover", preview: "hover" },
  { checked: true, id: "focus", preview: "focus" },
  { checked: false, disabled: true, id: "disabled-off" },
  { checked: true, disabled: true, id: "disabled-on" },
];

const PARTICIPANTS = [
  { checked: true, name: "Ольга Демченко", role: "CEO" },
  { checked: true, name: "Игорь Савчук", role: "техлид" },
  { checked: false, name: "Наталья Кравец", role: "бухгалтер" },
];

function StateCells({
  cell: Cell,
  states = STATES,
}: {
  cell: ComponentType<ChoiceState>;
  states?: ChoiceState[];
}) {
  return states.map((state) => (
    <StateCell key={state.id}>
      <Cell {...state} />
    </StateCell>
  ));
}

function CheckboxCell({ checked, disabled, preview }: ChoiceState) {
  return (
    <ChoiceField data-preview={preview}>
      <Checkbox defaultChecked={checked} disabled={disabled} />
      <ChoiceFieldLabel>Ольга Демченко</ChoiceFieldLabel>
    </ChoiceField>
  );
}

function RadioCell({ checked, disabled, preview }: ChoiceState) {
  const value = checked ? "ru" : "uk";

  return (
    <RadioGroup
      aria-label="Язык звонка"
      defaultValue={checked ? value : undefined}
      disabled={disabled}
    >
      <ChoiceField data-preview={preview}>
        <RadioGroupItem value={value} />
        <ChoiceFieldLabel>
          {checked ? "Русский" : "Украинский"}
        </ChoiceFieldLabel>
      </ChoiceField>
    </RadioGroup>
  );
}

function SwitchCell({ checked, disabled, preview }: ChoiceState) {
  return (
    <ChoiceField data-preview={preview}>
      <Switch defaultChecked={checked} disabled={disabled} />
      <ChoiceFieldLabel>Автостарт</ChoiceFieldLabel>
    </ChoiceField>
  );
}

/*
 * Segments have no on/off, so the columns show which segment is selected:
 * "Все" when off, "Открытые" when on. Hover sits on the unselected segment,
 * focus on the selected one, as in Paper.
 */
function SegmentsCell({ checked, disabled, preview }: ChoiceState) {
  return (
    <SegmentedControl
      aria-label="Какие вопросы показать"
      defaultValue={checked ? "open" : "all"}
      disabled={disabled}
    >
      <SegmentedControlItem
        data-preview={preview === "focus" ? "focus" : undefined}
        value="all"
      >
        Все
      </SegmentedControlItem>
      <SegmentedControlItem
        data-preview={preview === "hover" ? "hover" : undefined}
        value="open"
      >
        Открытые
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

/* The focus column pins focus on the selected "Все" segment */
const SEGMENT_STATES: ChoiceState[] = STATES.map((state) =>
  state.id === "focus" ? { ...state, checked: false } : state
);

function SettingsExample() {
  return (
    <Specimen
      caption="Строка настройки: название, пояснение, контрол справа"
      className="w-[540px]"
    >
      <SettingList>
        <SettingRow>
          <SettingRowContent>
            <SettingRowTitle htmlFor="choice-setting-autostart">
              Начинать при включении микрофона
            </SettingRowTitle>
            <SettingRowDescription>
              Покажем виджет, звонок стартует по кнопке
            </SettingRowDescription>
          </SettingRowContent>
          <SettingRowControl>
            <Switch defaultChecked id="choice-setting-autostart" />
          </SettingRowControl>
        </SettingRow>
        <SettingRow>
          <SettingRowContent>
            <SettingRowTitle htmlFor="choice-setting-hide">
              Скрывать окно при демонстрации экрана
            </SettingRowTitle>
            <SettingRowDescription>
              Клиент не увидит подсказки
            </SettingRowDescription>
          </SettingRowContent>
          <SettingRowControl>
            <Switch defaultChecked id="choice-setting-hide" />
          </SettingRowControl>
        </SettingRow>
        <SettingRow>
          <SettingRowContent>
            <SettingRowTitle>Завершать звонок сам</SettingRowTitle>
            <SettingRowDescription>
              Если микрофон свободен дольше 5 минут
            </SettingRowDescription>
          </SettingRowContent>
          <SettingRowControl>
            <SegmentedControl
              aria-label="Завершать звонок сам"
              defaultValue="10"
            >
              <SegmentedControlItem className="px-2.5" value="5">
                5 мин
              </SegmentedControlItem>
              <SegmentedControlItem className="px-2.5" value="10">
                10 мин
              </SegmentedControlItem>
              <SegmentedControlItem className="px-2.5" value="never">
                Никогда
              </SegmentedControlItem>
            </SegmentedControl>
          </SettingRowControl>
        </SettingRow>
      </SettingList>
    </Specimen>
  );
}

function ParticipantsExample() {
  return (
    <Specimen caption="Список чекбоксов с ролью справа">
      <fieldset className="w-80">
        <legend className="mb-3 text-sm font-medium">Кто на звонке</legend>
        <div className="flex flex-col gap-3">
          {PARTICIPANTS.map((participant) => (
            <ChoiceField key={participant.name}>
              <Checkbox defaultChecked={participant.checked} />
              <ChoiceFieldLabel>{participant.name}</ChoiceFieldLabel>
              <ChoiceFieldMeta>{participant.role}</ChoiceFieldMeta>
            </ChoiceField>
          ))}
        </div>
      </fieldset>
    </Specimen>
  );
}

function FilterAndTabsExample() {
  return (
    <div className="flex items-start gap-10">
      <Specimen caption="Фильтр: выбранный белым сегментом на сером треке, текст 500">
        <Tabs defaultValue="all">
          <TabsList aria-label="Фильтр проектов" size="sm">
            <TabsTrigger value="all">
              Все
              <TabsCount>6</TabsCount>
            </TabsTrigger>
            <TabsTrigger value="open">
              С открытыми вопросами
              <TabsCount tone="accent">3</TabsCount>
            </TabsTrigger>
            <TabsTrigger value="olga">Ольга Демченко</TabsTrigger>
          </TabsList>
        </Tabs>
      </Specimen>
      <Specimen caption="Вкладка: так же, чёрным остаётся только якорь темы в звонке">
        <Tabs defaultValue="brief">
          <TabsList aria-label="Разделы проекта">
            <TabsTrigger value="brief">Бриф</TabsTrigger>
            <TabsTrigger value="people">
              Люди
              <TabsCount>2</TabsCount>
            </TabsTrigger>
            <TabsTrigger value="calls">
              Звонки
              <TabsCount>6</TabsCount>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Specimen>
    </div>
  );
}

export function ChoiceSection() {
  return (
    <ShowcaseSection
      description="Чекбоксы, радио, переключатели и сегменты. Включённое состояние чёрное, без оранжевого."
      id="choice"
      title="Выбор"
    >
      <StateTable columns={STATE_COLUMNS}>
        <StateRow hint="18, скругление 6, кликается вся строка" label="Чекбокс">
          <StateCells cell={CheckboxCell} />
        </StateRow>
        <StateRow hint="18, точка 6" label="Радио">
          <StateCells cell={RadioCell} />
        </StateRow>
        <StateRow hint="36 на 22" label="Переключатель">
          <StateCells cell={SwitchCell} />
        </StateRow>
        <StateRow hint="выбран белый" label="Сегменты">
          <StateCells cell={SegmentsCell} states={SEGMENT_STATES} />
        </StateRow>
      </StateTable>

      <ShowcaseGroup title="В контексте настроек">
        <div className="flex items-start gap-16">
          <SettingsExample />
          <ParticipantsExample />
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Фильтр и вкладка, выбранное">
        <FilterAndTabsExample />
      </ShowcaseGroup>
    </ShowcaseSection>
  );
}
