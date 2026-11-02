import { cn } from "@/lib/utils";

/*
 * "Скажите что-нибудь, чтобы проверить": after the model is ready, what the
 * microphone hears is transcribed live into a gray card, with a red
 * "слушаю" dot and an orange caret after the last word.
 */
export function MicCheck({
  className,
  listeningLabel = "слушаю",
  title = "Скажите что-нибудь, чтобы проверить",
  transcript,
}: {
  className?: string;
  listeningLabel?: string;
  title?: string;
  transcript: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "bg-surface flex flex-col gap-2 rounded-md px-4 py-3.5",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="bg-recording size-1.5 shrink-0 rounded-full"
          />
          {listeningLabel}
        </p>
      </div>
      <p aria-live="polite" className="text-lg">
        {transcript}
        <span
          aria-hidden="true"
          className="bg-accent ml-0.5 inline-block h-[18px] w-0.5 align-[-3px]"
        />
      </p>
    </section>
  );
}
