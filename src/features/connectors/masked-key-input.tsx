"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ComponentProps,
  type FocusEvent,
  useCallback,
  useState,
} from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/*
 * An API key field (connectors spec, «Проверка ключа»): after a paste the
 * key shows its start and its last 4 characters, the rest as dots; the eye
 * shows it whole. While masked, an edit replaces the whole key: focus
 * selects it, a paste or typing over the selection is the new key, and
 * erasing inside the dots clears it.
 */

const DOT = "•";
const TAIL = 4;
/** Outline's `ol_api_`, ClickUp's `pk_<user id>_`. */
const KNOWN_PREFIX = /^(?:[a-z]+_api_|pk_\d+_)/u;
const HEAD = 4;
/** Shorter keys are all dots: a start and an end would give them away. */
const MIN_REVEALED_LENGTH = 12;

/** "ol_api_x9Pq…7Xk2" with dots in the middle. */
export function maskKey(key: string) {
  if (key.length < MIN_REVEALED_LENGTH) {
    return DOT.repeat(key.length);
  }
  const head = KNOWN_PREFIX.exec(key)?.[0].length ?? HEAD;
  const middle = Math.max(TAIL, key.length - head - TAIL);
  return `${key.slice(0, head)}${DOT.repeat(middle)}${key.slice(-TAIL)}`;
}

export function MaskedKeyInput({
  className,
  noun = "ключ",
  onValueChange,
  value,
  ...props
}: Omit<ComponentProps<"input">, "onChange" | "type" | "value"> & {
  /** What it holds, for the eye's label: «ключ», «токен». */
  noun?: string;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const [visible, setVisible] = useState(false);
  const masked = maskKey(value);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      if (visible || !next.includes(DOT)) {
        onValueChange(next);
      } else if (next.length < masked.length) {
        onValueChange("");
      }
    },
    [masked.length, onValueChange, visible]
  );
  const handleFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      if (!visible) {
        event.currentTarget.select();
      }
    },
    [visible]
  );
  const toggle = useCallback(() => setVisible((shown) => !shown), []);

  return (
    <InputGroup className={className} data-slot="password-input">
      <InputGroupInput
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="font-mono text-sm/5 placeholder-shown:font-sans placeholder-shown:text-base"
        onChange={handleChange}
        onFocus={handleFocus}
        spellCheck={false}
        type="text"
        value={visible ? value : masked}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={visible ? `Скрыть ${noun}` : `Показать ${noun}`}
          className={cn(
            "text-muted-foreground hover:bg-transparent",
            "group-[:not(:hover,:focus-within):has(input:placeholder-shown)]/input-group:text-subtle group-focus-within/input-group:text-foreground"
          )}
          disabled={props.disabled}
          onClick={toggle}
          size="icon-sm"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
