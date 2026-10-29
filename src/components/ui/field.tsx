"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { CircleAlertIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className
      )}
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base",
        className
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
        className
      )}
      {...props}
    />
  )
}

/*
 * Field wires its parts together: the label points at the control, and the
 * control is described by the hint and the error. Controls (Input, Textarea,
 * SelectTrigger, InputGroupInput) read this through useFieldControl.
 */
type FieldContextValue = {
  invalid: boolean
  controlId: string | undefined
  setControlId: (id: string | undefined) => void
  descriptionIds: string[]
  errorIds: string[]
  register: (kind: "description" | "error", id: string) => () => void
}

const FieldContext = React.createContext<FieldContextValue | null>(null)

function useFieldContext() {
  return React.useContext(FieldContext)
}

type FieldControlProps = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: React.AriaAttributes["aria-invalid"]
}

/** id, aria-describedby and aria-invalid for a control inside a Field. */
function useFieldControl<P extends FieldControlProps>(props: P): FieldControlProps {
  const field = useFieldContext()
  const generatedId = React.useId()
  const id = props.id ?? (field ? generatedId : undefined)
  const setControlId = field?.setControlId

  React.useEffect(() => {
    if (!setControlId) {
      return
    }
    setControlId(id)
    return () => setControlId(undefined)
  }, [setControlId, id])

  if (!field) {
    return {
      id: props.id,
      "aria-describedby": props["aria-describedby"],
      "aria-invalid": props["aria-invalid"],
    }
  }

  const describedBy = [
    props["aria-describedby"],
    ...field.descriptionIds,
    ...field.errorIds,
  ]
    .filter(Boolean)
    .join(" ")
  const invalid = field.invalid || field.errorIds.length > 0

  return {
    id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (invalid || undefined),
  }
}

function useFieldPart(kind: "description" | "error", id: string, active = true) {
  const register = useFieldContext()?.register

  React.useEffect(() => {
    if (!register || !active) {
      return
    }
    return register(kind, id)
  }, [register, kind, id, active])
}

const fieldVariants = cva(
  "group/field flex w-full gap-1.5",
  {
    variants: {
      orientation: {
        vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
        horizontal:
          "flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        responsive:
          "flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  }
)

function Field({
  className,
  orientation = "vertical",
  invalid = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants> & {
    /** Marks the control invalid even without a FieldError. */
    invalid?: boolean
  }) {
  const [controlId, setControlId] = React.useState<string | undefined>()
  const [descriptionIds, setDescriptionIds] = React.useState<string[]>([])
  const [errorIds, setErrorIds] = React.useState<string[]>([])

  const register = React.useCallback(
    (kind: "description" | "error", id: string) => {
      const setIds = kind === "error" ? setErrorIds : setDescriptionIds
      setIds((ids) => [...ids, id])
      return () => setIds((ids) => ids.filter((current) => current !== id))
    },
    []
  )

  const context = React.useMemo(
    () => ({
      invalid,
      controlId,
      setControlId,
      descriptionIds,
      errorIds,
      register,
    }),
    [invalid, controlId, descriptionIds, errorIds, register]
  )

  return (
    <FieldContext.Provider value={context}>
      <div
        role="group"
        data-slot="field"
        data-orientation={orientation}
        data-invalid={invalid || errorIds.length > 0 || undefined}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      />
    </FieldContext.Provider>
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "group/field-content flex flex-1 flex-col gap-0.5 leading-snug",
        className
      )}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  htmlFor,
  ...props
}: React.ComponentProps<typeof Label>) {
  const controlId = useFieldContext()?.controlId

  return (
    <Label
      data-slot="field-label"
      htmlFor={htmlFor ?? controlId}
      className={cn(
        "group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 *:data-[slot=field]:p-2.5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10",
        "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm font-medium group-data-[disabled=true]/field:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({
  className,
  id,
  ...props
}: React.ComponentProps<"p">) {
  const generatedId = React.useId()
  const descriptionId = id ?? generatedId
  useFieldPart("description", descriptionId)

  return (
    <p
      id={descriptionId}
      data-slot="field-description"
      className={cn(
        "text-left text-sm font-normal text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5",
        "[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        "relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2",
        className
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  id,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  const generatedId = React.useId()
  const errorId = id ?? generatedId
  const content = React.useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ]

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map(
          (error, index) =>
            error?.message && <li key={index}>{error.message}</li>
        )}
      </ul>
    )
  }, [children, errors])

  useFieldPart("error", errorId, Boolean(content))

  if (!content) {
    return null
  }

  return (
    <div
      id={errorId}
      role="alert"
      data-slot="field-error"
      className={cn(
        "flex items-start gap-1.5 text-sm font-normal text-destructive",
        className
      )}
      {...props}
    >
      <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">{content}</div>
    </div>
  )
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
  useFieldControl,
}
