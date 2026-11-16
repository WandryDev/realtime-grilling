import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * "Скажите что-нибудь, чтобы проверить": after the model is ready, the
 * microphone listens for a phrase (a red "слушаю" dot), then what the model
 * heard shows at once in a gray card with an orange caret after it. `note`
 * replaces the text when nothing was heard or the check failed; "Проверить
 * ещё раз" (`onAgain`) listens again.
 */
export function MicCheck({
  className,
  listening = true,
  listeningLabel = "слушаю",
  note,
  onAgain,
  title = "Скажите что-нибудь, чтобы проверить",
  transcript,
}: {
  className?: string;
  listening?: boolean;
  listeningLabel?: string;
  note?: string;
  onAgain?: () => void;
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
        {listening ? (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="bg-recording size-1.5 shrink-0 rounded-full"
            />
            {listeningLabel}
          </p>
        ) : null}
        {!listening && onAgain ? (
          <Button
            className="-my-1 h-7 px-3"
            onClick={onAgain}
            variant="secondary"
          >
            Проверить ещё раз
          </Button>
        ) : null}
      </div>
      {note ? (
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {note}
        </p>
      ) : (
        <p aria-live="polite" className="text-lg">
          {transcript}
          <span
            aria-hidden="true"
            className="bg-accent ml-0.5 inline-block h-[18px] w-0.5 align-[-3px]"
          />
        </p>
      )}
    </section>
  );
}
