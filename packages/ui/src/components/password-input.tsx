"use client"

import * as React from "react"
import { cn } from "cn"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./input-group"

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** Shows the value as plain text (controlled). */
  visible?: boolean
  defaultVisible?: boolean
  onVisibleChange?: (visible: boolean) => void
  /** Accessible names of the eye toggle. */
  showLabel?: string
  hideLabel?: string
  /** Pins a state on the field box for /dev. */
  "data-preview"?: string
}

/*
 * Paper "02 Поля", API-ключ: the value is masked and set in JetBrains Mono,
 * the eye on the right shows it. `className` and `data-preview` go to the
 * field box, everything else to the input.
 */
function PasswordInput({
  className,
  visible: visibleProp,
  defaultVisible = false,
  onVisibleChange,
  showLabel = "Показать ключ",
  hideLabel = "Скрыть ключ",
  disabled,
  "data-preview": preview,
  ...props
}: PasswordInputProps) {
  const [visibleState, setVisibleState] = React.useState(defaultVisible)
  const visible = visibleProp ?? visibleState

  const toggle = () => {
    const next = !visible
    setVisibleState(next)
    onVisibleChange?.(next)
  }

  return (
    <InputGroup
      data-slot="password-input"
      data-preview={preview}
      className={className}
    >
      <InputGroupInput
        type={visible ? "text" : "password"}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-sm/5 placeholder-shown:font-sans placeholder-shown:text-base"
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-sm"
          aria-label={visible ? hideLabel : showLabel}
          disabled={disabled}
          onClick={toggle}
          className={cn(
            "text-muted-foreground hover:bg-transparent data-disabled:not-data-loading:opacity-100",
            // Pale while empty and idle, ink while the field has focus
            "group-[:not(:hover,:focus-within,[data-preview]):has(input:placeholder-shown)]/input-group:text-subtle group-focus-within/input-group:text-foreground data-disabled:text-subtle"
          )}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

export { PasswordInput, type PasswordInputProps }
