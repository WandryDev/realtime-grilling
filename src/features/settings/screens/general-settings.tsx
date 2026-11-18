"use client";

import type { RecordingsInfo, UpdateStatus } from "@/bindings";
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
import { CALL_LANGUAGES, RECORDINGS, THEMES, UPDATES } from "../mock";

/**
 * "Общие": the call language, launch and theme, the recordings folder, the
 * app's version and its updates. Controls are bound to `values` when
 * `onChange` is set (the app), free otherwise. `recordings` and `updates`
 * are `null` until the backend answered.
 */
export function GeneralSettings({
  onChange,
  onCheckUpdates,
  onRestartToUpdate,
  onShowInFinder,
  recordings = RECORDINGS,
  revealLabel = "Показать в Finder",
  updates = UPDATES,
  values = DEFAULT_SETTINGS,
}: {
  onChange?: SettingChange;
  /** «Проверить обновления». */
  onCheckUpdates?: () => void;
  /** «Перезапустить»: installs the downloaded update. */
  onRestartToUpdate?: () => void;
  onShowInFinder?: () => void;
  recordings?: RecordingsInfo | null;
  /** «Показать в Finder», «Показать в проводнике» on Windows. */
  revealLabel?: string;
  updates?: UpdateStatus | null;
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
      <SettingsSection className="pt-12" title="Запуск и вид">
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
      <SettingsSection className="pt-12" title="Записи">
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
      <SettingsSection className="pt-12" title="Обновления">
        <SettingsRow
          control={
            <UpdateControl
              onCheck={onCheckUpdates}
              onRestart={onRestartToUpdate}
              updates={updates}
            />
          }
          description={updates ? updateDescription(updates) : "…"}
          title={updates ? `Grill ${updates.current}` : "Grill"}
        />
      </SettingsSection>
    </>
  );
}

/** What the updater is doing, under the version. */
function updateDescription({ state }: UpdateStatus): string {
  switch (state.status) {
    case "disabled":
      return "Сборка для разработки не обновляется";
    case "idle":
      return "Grill проверяет обновления сам, раз в несколько часов";
    case "checking":
      return "Проверяем обновления…";
    case "upToDate":
      return "Установлена последняя версия";
    case "downloading":
      return state.percent === null
        ? `Скачиваем версию ${state.version}…`
        : `Скачиваем версию ${state.version}: ${state.percent}%`;
    case "ready":
      return `Версия ${state.version} скачана. Перезапустите Grill, чтобы установить её`;
    case "installing":
      return `Устанавливаем версию ${state.version}…`;
    default:
      return state.message;
  }
}

function UpdateControl({
  onCheck,
  onRestart,
  updates,
}: {
  onCheck?: () => void;
  onRestart?: () => void;
  updates: UpdateStatus | null;
}) {
  const status = updates?.state.status;
  if (status === "disabled") {
    return null;
  }
  if (status === "ready" || status === "installing") {
    return (
      <Button loading={status === "installing"} onClick={onRestart}>
        Перезапустить
      </Button>
    );
  }
  const busy = status === "checking" || status === "downloading";
  return (
    <Button
      disabled={!updates || busy}
      loading={status === "checking"}
      onClick={onCheck}
      variant="secondary"
    >
      Проверить обновления
    </Button>
  );
}

export function GeneralSettingsScreen({ className }: { className?: string }) {
  return (
    <SettingsScreen className={className} section="general">
      <GeneralSettings />
    </SettingsScreen>
  );
}
