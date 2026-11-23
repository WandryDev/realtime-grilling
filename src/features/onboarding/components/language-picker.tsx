import { ChoiceField, ChoiceFieldLabel } from "@grill/ui/choice-field";
import { RadioGroup, RadioGroupItem } from "@grill/ui/radio-group";
import { useCallback, useId } from "react";
import { cn } from "@/lib/utils";
import type { SpeechLanguage } from "../mock";

/*
 * "На каком языке проходят звонки": two 48px option cards side by side. The
 * selected one is white with a 1.5px ink outline, the other stays gray.
 * `muted` dims the other options while the model downloads, `hint` is the
 * muted line underneath ("Язык можно сменить после загрузки"), and the
 * choice is locked meanwhile.
 *
 * With `onValueChange` the picker is controlled by `value` (the app),
 * without it `value` is only the initial choice (previews).
 */
export function LanguagePicker({
  className,
  hint,
  label = "На каком языке проходят звонки",
  languages,
  muted = false,
  onValueChange,
  value,
}: {
  className?: string;
  hint?: string;
  label?: string;
  languages: readonly SpeechLanguage[];
  muted?: boolean;
  onValueChange?: (value: string) => void;
  value: string;
}) {
  const labelId = useId();
  const handleValueChange = useCallback(
    (next: unknown) => {
      if (typeof next === "string") {
        onValueChange?.(next);
      }
    },
    [onValueChange]
  );
  const valueProps = onValueChange
    ? { onValueChange: handleValueChange, value }
    : { defaultValue: value };

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <p className="text-muted-foreground text-sm font-medium" id={labelId}>
        {label}
      </p>
      <RadioGroup
        aria-labelledby={labelId}
        className="flex gap-2"
        readOnly={muted}
        {...valueProps}
      >
        {languages.map((language) => (
          <ChoiceField
            className="bg-surface has-data-checked:bg-background h-12 flex-1 rounded-sm px-4 has-data-checked:shadow-[0_0_0_1.5px_var(--color-foreground)]"
            key={language.id}
          >
            <RadioGroupItem className="size-4" value={language.id} />
            <ChoiceFieldLabel
              className={cn(
                "font-medium",
                muted && "group-has-data-unchecked/choice:text-muted-foreground"
              )}
            >
              {language.label}
            </ChoiceFieldLabel>
          </ChoiceField>
        ))}
      </RadioGroup>
      {hint ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
    </div>
  );
}
