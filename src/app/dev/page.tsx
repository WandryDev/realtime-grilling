import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonsSection } from "./_sections/buttons";
import { ChoiceSection } from "./_sections/choice";
import { ContextCardsSection } from "./_sections/context-cards";
import { FeedbackSection } from "./_sections/feedback";
import { FieldsSection } from "./_sections/fields";
import { FoundationsSection } from "./_sections/foundations";
import { LabelsSection } from "./_sections/labels";
import { ListRowsSection } from "./_sections/list-rows";
import { QuestionSection } from "./_sections/question";
import { TranscriptSection } from "./_sections/transcript";
import { WindowsSection } from "./_sections/windows";

export const metadata: Metadata = {
  title: "Grill, дизайн-система",
};

const SECTIONS = [
  { id: "foundations", title: "Основы" },
  { id: "buttons", title: "Кнопки" },
  { id: "fields", title: "Поля" },
  { id: "choice", title: "Выбор" },
  { id: "labels", title: "Метки и пилюли" },
  { id: "question", title: "Вопрос" },
  { id: "transcript", title: "Сообщения расшифровки" },
  { id: "context-cards", title: "Карточки контекста" },
  { id: "list-rows", title: "Строки списков" },
  { id: "feedback", title: "Обратная связь" },
  { id: "windows", title: "Окна и оболочки" },
] as const;

// Component catalog for development. Not shipped in the production build.
export default function DevPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="min-h-svh">
      <header className="border-border bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center gap-6 px-16 py-3">
          <p className="shrink-0 text-base font-semibold">
            Grill, дизайн-система
          </p>
          <nav
            aria-label="Разделы дизайн-системы"
            className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 py-1"
          >
            {SECTIONS.map((section) => (
              <a
                className="text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:focus-ring shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors"
                href={`#${section.id}`}
                key={section.id}
              >
                {section.title}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-16 py-16">
        <FoundationsSection />
        <ButtonsSection />
        <FieldsSection />
        <ChoiceSection />
        <LabelsSection />
        <QuestionSection />
        <TranscriptSection />
        <ContextCardsSection />
        <ListRowsSection />
        <FeedbackSection />
        <WindowsSection />
      </main>
    </div>
  );
}
