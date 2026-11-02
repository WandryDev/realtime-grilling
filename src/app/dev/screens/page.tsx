import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Grill, экраны",
};

const FLOWS = [
  {
    description:
      "Виджет старта, микрофон освободился, компактный оверлей поверх других окон",
    href: "/dev/screens/call-widgets",
    title: "Звонок, виджеты",
  },
  {
    description:
      "Начало звонка, основной экран, финальная проверка, ошибки, завершение",
    href: "/dev/screens/call",
    title: "Звонок, окно",
  },
  {
    description: "Приветствие, разрешения, модель речи, агент, интеграции",
    href: "/dev/screens/onboarding",
    title: "Онбординг",
  },
  {
    description: "Главная, новый проект, бриф, люди клиента, удаление",
    href: "/dev/screens/projects",
    title: "Проекты",
  },
  {
    description:
      "Общие, звук, агент, виджет и клавиши, приватность, интеграции",
    href: "/dev/screens/settings",
    title: "Настройки",
  },
  {
    description:
      "Сборка итогов, итоги, ревью предложений, история, детали звонка",
    href: "/dev/screens/post-call",
    title: "После звонка",
  },
] as const;

// Screen catalog for development. Not shipped in the production build.
export default function ScreensPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <main className="max-w-content mx-auto flex flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Экраны Grill</h1>
        <p className="text-muted-foreground text-base">
          Все состояния из Paper, собранные на компонентах из{" "}
          <a className="underline underline-offset-2" href="/dev">
            дизайн-системы
          </a>
          .
        </p>
      </header>
      <nav aria-label="Потоки" className="flex flex-col">
        {FLOWS.map((flow) => (
          <a
            className="border-border hover:bg-surface focus-visible:focus-ring flex flex-col gap-0.5 rounded-sm border-b px-4 py-4 transition-colors last:border-b-0"
            href={flow.href}
            key={flow.href}
          >
            <span className="text-lg font-medium">{flow.title}</span>
            <span className="text-muted-foreground text-sm">
              {flow.description}
            </span>
          </a>
        ))}
      </nav>
    </main>
  );
}
