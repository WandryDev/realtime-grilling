"use client";

import { Button } from "@grill/ui/button";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";

import {
  SettingsRadioGroup,
  SettingsRadioRow,
  SettingsRow,
  SettingsSection,
  SettingsSegments,
  SettingsSwitch,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { ShortcutRow } from "../components/shortcut-field";
import {
  AUTO_END,
  MIC_BUSY_BEHAVIORS,
  SHORTCUTS,
  type Shortcut,
} from "../mock";

/** Modifiers held while a shortcut is being recorded. */
const HELD_MODIFIERS = ["⌥", "⌘"];

/**
 * "Виджет и клавиши": what happens when a call starts, the overlay during the
 * call and the global shortcuts. `recording` is the id of the shortcut being
 * recorded right now, `heldKeys` the modifiers held while recording. The
 * keys of each shortcut come from `values.shortcuts`.
 */
export function WidgetSettings({
  heldKeys = HELD_MODIFIERS,
  onChange,
  onRecord,
  onResetShortcuts,
  recording,
  shortcutErrors,
  shortcuts = SHORTCUTS,
  values = DEFAULT_SETTINGS,
}: {
  heldKeys?: string[];
  onChange?: SettingChange;
  /** Click on a shortcut field, with the shortcut id. */
  onRecord?: (id: string) => void;
  onResetShortcuts?: () => void;
  recording?: string;
  /** Shortcuts the OS refused, by id: why. They keep their previous keys. */
  shortcutErrors?: Record<string, string>;
  shortcuts?: Shortcut[];
  values?: SettingsValues;
}) {
  return (
    <>
      <SettingsSection
        className="pt-4"
        title="Когда микрофон занял Zoom, Meet или Telegram"
      >
        <SettingsRadioGroup
          aria-label="Когда микрофон занял Zoom, Meet или Telegram"
          defaultValue={values.micBusyBehavior}
          onSettingChange={onChange}
          setting="micBusyBehavior"
        >
          {MIC_BUSY_BEHAVIORS.map((behavior) => (
            <SettingsRadioRow
              description={behavior.description}
              key={behavior.value}
              title={behavior.label}
              value={behavior.value}
            />
          ))}
        </SettingsRadioGroup>
      </SettingsSection>
      <SettingsSection className="pt-12" title="Во время звонка">
        <SettingsRow
          control={
            <SettingsSwitch
              checked={values.compactOverlay}
              id="settings-compact-overlay"
              onSettingChange={onChange}
              setting="compactOverlay"
            />
          }
          description="Только главный вопрос и таймер, основное окно можно свернуть"
          htmlFor="settings-compact-overlay"
          title="Компактный оверлей поверх звонилки"
        />
        <SettingsRow
          control={
            <SettingsSwitch
              checked={values.hideOnShare}
              id="settings-hide-on-share"
              onSettingChange={onChange}
              setting="hideOnShare"
            />
          }
          description="Клиент не увидит подсказки, даже если вы покажете весь экран"
          htmlFor="settings-hide-on-share"
          title="Скрывать при демонстрации экрана"
        />
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.autoEnd}
              label="Завершать звонок сам"
              onSettingChange={onChange}
              options={AUTO_END}
              setting="autoEnd"
            />
          }
          description="Если микрофон освободился, а вы не ответили на предложение завершить"
          title="Завершать звонок сам"
        />
      </SettingsSection>
      <SettingsSection
        action={
          <Button
            className="-mx-2 -my-1.5 px-2"
            onClick={onResetShortcuts}
            size="sm"
            variant="ghost"
          >
            Сбросить все
          </Button>
        }
        className="pt-12"
        title="Сочетания клавиш, работают из любого приложения"
      >
        <div className="flex flex-col gap-4">
          {shortcuts.map((shortcut) => {
            const isRecording = shortcut.id === recording;
            const keys = values.shortcuts[shortcut.id] ?? shortcut.keys;
            return (
              <ShortcutRow
                error={shortcutErrors?.[shortcut.id]}
                id={shortcut.id}
                key={shortcut.id}
                keys={isRecording ? heldKeys : keys}
                label={shortcut.label}
                onRecord={onRecord}
                recording={isRecording}
              />
            );
          })}
        </div>
      </SettingsSection>
    </>
  );
}

export function WidgetSettingsScreen({
  className,
  recording,
}: {
  className?: string;
  recording?: string;
}) {
  return (
    <SettingsScreen className={className} section="widget">
      <WidgetSettings recording={recording} />
    </SettingsScreen>
  );
}
