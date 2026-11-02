"use client";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";

import {
  ReadonlyField,
  SettingsRow,
  SettingsSection,
  SettingsSegments,
  SettingsSelect,
  SettingsSwitch,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { FolderIcon } from "../icons";
import {
  CALL_LANGUAGES,
  INTERFACE_LANGUAGES,
  RECORDINGS,
  THEMES,
} from "../mock";

/**
 * "Общие": languages, launch and theme, the recordings folder. Controls are
 * bound to `values` when `onChange` is set (the app), free otherwise.
 */
export function GeneralSettings({
  onChange,
  onChangeFolder,
  onShowInFinder,
  recordings = RECORDINGS,
  values = DEFAULT_SETTINGS,
}: {
  onChange?: SettingChange;
  /** "Изменить": pick another folder and move the recordings there. */
  onChangeFolder?: () => void;
  onShowInFinder?: () => void;
  recordings?: typeof RECORDINGS;
  values?: SettingsValues;
}) {
  return (
    <>
      <SettingsSection className="pt-4" title="Язык">
        <SettingsRow
          control={
            <SettingsSelect
              defaultValue={values.interfaceLanguage}
              id="settings-interface-language"
              onSettingChange={onChange}
              options={INTERFACE_LANGUAGES}
              setting="interfaceLanguage"
            />
          }
          description="Меню, кнопки и подсказки Grill"
          htmlFor="settings-interface-language"
          title="Язык интерфейса"
        />
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.callLanguage}
              label="Язык звонков"
              onSettingChange={onChange}
              options={CALL_LANGUAGES}
              setting="callLanguage"
            />
          }
          description="Под него настроится распознавание речи"
          title="Язык звонков"
        />
      </SettingsSection>
      <SettingsSection className="pt-8" title="Запуск и вид">
        <SettingsRow
          control={
            <SettingsSwitch
              checked={values.launchAtLogin}
              id="settings-autostart"
              onSettingChange={onChange}
              setting="launchAtLogin"
            />
          }
          description="Grill тихо ждёт в строке меню и заметит, когда начнётся звонок"
          htmlFor="settings-autostart"
          title="Открывать при входе в систему"
        />
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.theme}
              label="Тема"
              onSettingChange={onChange}
              options={THEMES}
              setting="theme"
            />
          }
          description="Тёмная появится позже"
          title="Тема"
        />
      </SettingsSection>
      <SettingsSection className="pt-8" title="Записи">
        <SettingsRow
          control={
            <div className="flex items-center gap-2">
              <Button
                className="px-3.5"
                onClick={onShowInFinder}
                variant="ghost"
              >
                Показать в Finder
              </Button>
              <Button onClick={onChangeFolder} variant="secondary">
                Изменить
              </Button>
            </div>
          }
          description={recordings.usage}
          title="Папка для записей"
        >
          <ReadonlyField icon={<FolderIcon />}>
            {values.recordingsFolder}
          </ReadonlyField>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

export function GeneralSettingsScreen({ className }: { className?: string }) {
  return (
    <SettingsScreen className={className} section="general">
      <GeneralSettings />
    </SettingsScreen>
  );
}
