"use client";

import type { RecordingsInfo } from "@/bindings";
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
  SettingsSwitch,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { recordingsUsage } from "../format";
import { FolderIcon } from "../icons";
import { CALL_LANGUAGES, RECORDINGS, THEMES } from "../mock";

/**
 * "Общие": the call language, launch and theme, the recordings folder.
 * Controls are bound to `values` when `onChange` is set (the app), free
 * otherwise. `recordings` is `null` until the backend answered.
 */
export function GeneralSettings({
  onChange,
  onShowInFinder,
  recordings = RECORDINGS,
  revealLabel = "Показать в Finder",
  values = DEFAULT_SETTINGS,
}: {
  onChange?: SettingChange;
  onShowInFinder?: () => void;
  recordings?: RecordingsInfo | null;
  /** «Показать в Finder», «Показать в проводнике» on Windows. */
  revealLabel?: string;
  values?: SettingsValues;
}) {
  return (
    <>
      <SettingsSection className="pt-4" title="Язык">
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
          description="Сразу во всех окнах Grill. «Как в системе» меняется вместе с системой"
          title="Тема"
        />
      </SettingsSection>
      <SettingsSection className="pt-8" title="Записи">
        <SettingsRow
          control={
            <Button
              disabled={!recordings}
              onClick={onShowInFinder}
              variant="secondary"
            >
              {revealLabel}
            </Button>
          }
          description={recordings ? recordingsUsage(recordings) : "Считаем…"}
          title="Папка для записей"
        >
          <ReadonlyField icon={<FolderIcon />}>
            {recordings?.path ?? "…"}
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
