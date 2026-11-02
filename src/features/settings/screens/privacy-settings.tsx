"use client";

import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";
import { cn } from "@/lib/utils";

import {
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { CheckIcon, UploadIcon } from "../icons";
import {
  AUDIO_RETENTION,
  DATA_POLICY,
  DATA_SUMMARY,
  TRANSCRIPT_RETENTION,
} from "../mock";

/*
 * "Что уходит с компьютера": a gray card that explains, not configures. A
 * green check for what stays local, the agent mark for the one exception.
 */
export function DataPolicyCard({
  className,
  items = DATA_POLICY,
}: {
  className?: string;
  items?: typeof DATA_POLICY;
}) {
  return (
    <section
      aria-labelledby="data-policy-title"
      className={cn(
        "bg-surface flex flex-col gap-3.5 rounded-md p-5",
        className
      )}
    >
      <h2 className="text-base font-semibold" id="data-policy-title">
        Что уходит с компьютера
      </h2>
      <ul className="flex flex-col gap-3.5">
        {items.map((item) => (
          <li className="flex items-start gap-3" key={item.id}>
            <span className="flex size-5 shrink-0 items-center justify-center">
              {item.kind === "agent" ? (
                <ClaudeIcon className="size-3.5" />
              ) : (
                <CheckIcon className="text-confirmed size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1 text-base">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Приватность и хранение": what leaves the computer, retention, your data. */
export function PrivacySettings({
  onChange,
  onDeleteAll,
  onExport,
  values = DEFAULT_SETTINGS,
}: {
  onChange?: SettingChange;
  /** "Очистить всё": the confirmation dialog. */
  onDeleteAll?: () => void;
  /** "Экспортировать": the export dialog. */
  onExport?: () => void;
  values?: SettingsValues;
}) {
  return (
    <>
      <DataPolicyCard />
      <SettingsSection className="pt-8" title="Сколько хранить">
        <SettingsRow
          control={
            <SettingsSelect
              defaultValue={values.audioRetention}
              id="settings-audio-retention"
              onSettingChange={onChange}
              options={AUDIO_RETENTION}
              setting="audioRetention"
            />
          }
          description="Потом аудио удалится, расшифровка и итог останутся"
          htmlFor="settings-audio-retention"
          title="Аудиозаписи звонков"
        />
        <SettingsRow
          control={
            <SettingsSelect
              defaultValue={values.transcriptRetention}
              id="settings-transcript-retention"
              onSettingChange={onChange}
              options={TRANSCRIPT_RETENTION}
              setting="transcriptRetention"
            />
          }
          description="Итоги звонков, бриф и профили людей остаются всегда"
          htmlFor="settings-transcript-retention"
          title="Расшифровки"
        />
      </SettingsSection>
      <SettingsSection className="pt-8" title="Ваши данные">
        <SettingsRow
          control={
            <Button onClick={onExport} variant="secondary">
              <UploadIcon className="size-3.5" />
              Экспортировать
            </Button>
          }
          description="Все проекты, итоги и расшифровки в Markdown, аудио по желанию"
          title="Экспорт данных"
        />
        <SettingsRow
          control={
            <Button
              className="text-contradiction hover:text-contradiction focus-visible:text-contradiction active:text-contradiction px-3.5"
              onClick={onDeleteAll}
              variant="ghost"
            >
              Очистить всё
            </Button>
          }
          description={DATA_SUMMARY}
          title="Удалить всё из Grill"
        />
      </SettingsSection>
    </>
  );
}

export function PrivacySettingsScreen({ className }: { className?: string }) {
  return (
    <SettingsScreen className={className} section="privacy">
      <PrivacySettings />
    </SettingsScreen>
  );
}
