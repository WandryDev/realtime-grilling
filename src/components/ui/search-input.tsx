"use client"

import * as React from "react"
import { cn } from "cn"
import { SearchIcon } from "lucide-react"

import { InputGroupInput } from "@/components/ui/input-group"

type SearchInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** Called after the clear button empties the field. */
  onClear?: () => void
  /** Accessible name of the clear button. */
  clearLabel?: string
  /** Pins a state on the pill for /dev. */
  "data-preview"?: string
}

/*
 * Paper "02 Поля", Поиск: a gray pill, 36 high. Hover darkens the pill, focus
 * and error turn it into a white field with a border and a halo. A clear
 * button appears once there is a query. `className` and `data-preview` go to
 * the pill, everything else to the input.
 */
function SearchInput({
  className,
  value,
  defaultValue,
  onChange,
  onClear,
  clearLabel = "Очистить поиск",
  disabled,
  ref,
  "data-preview": preview,
  ...props
}: SearchInputProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [innerValue, setInnerValue] = React.useState(defaultValue ?? "")
  const isControlled = value !== undefined
  const currentValue = isControlled ? value : innerValue
  const hasValue = String(currentValue ?? "").length > 0

  const setRefs = (node: HTMLInputElement | null) => {
    inputRef.current = node
    if (typeof ref === "function") {
      ref(node)
    } else if (ref) {
      ref.current = node
    }
  }

  const clear = () => {
    if (!isControlled) {
      setInnerValue("")
    }
    onClear?.()
    inputRef.current?.focus()
  }

  return (
    <div
      data-slot="search-input"
      data-preview={preview}
      data-filled={(hasValue && !disabled) || undefined}
      className={cn(
        "group/search flex h-9 w-full min-w-0 items-center gap-2 rounded-full border border-transparent bg-surface px-3 text-base text-foreground transition-[border-color,box-shadow,background-color]",
        "not-has-[[aria-invalid=true]]:hover:bg-border not-has-[[aria-invalid=true]]:focus-within:bg-background not-has-[[aria-invalid=true]]:focus-within:field-focus",
        "has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:bg-background has-[[aria-invalid=true]]:shadow-[0_0_0_3px_var(--color-contradiction-soft)]",
        "has-[input:disabled]:pointer-events-none has-[input:disabled]:text-subtle",
        className
      )}
    >
      <SearchIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground group-hover/search:text-foreground group-focus-within/search:text-foreground group-data-filled/search:text-foreground group-has-[[aria-invalid=true]]/search:text-foreground group-has-[input:disabled]/search:text-subtle"
      />
      <InputGroupInput
        ref={setRefs}
        type="search"
        value={currentValue}
        disabled={disabled}
        onChange={(event) => {
          if (!isControlled) {
            setInnerValue(event.target.value)
          }
          onChange?.(event)
        }}
        className="[&::-webkit-search-cancel-button]:appearance-none"
        {...props}
      />
      {hasValue && !disabled ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={clear}
          className="-my-1.5 -mr-[5px] flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:focus-ring"
        >
          <span className="flex size-4.5 items-center justify-center rounded-full bg-border-strong text-background">
            <svg aria-hidden viewBox="0 0 8 8" fill="none" className="size-2">
              <path
                d="M1.5 1.5L6.5 6.5M6.5 1.5L1.5 6.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </button>
      ) : null}
    </div>
  )
}

export { SearchInput, type SearchInputProps }
