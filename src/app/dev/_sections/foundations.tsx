import {
  ShowcaseGroup,
  ShowcaseSection,
  Specimen,
} from "../_components/showcase";

const NEUTRALS = [
  {
    name: "Paper",
    swatch: "bg-background border border-border",
    token: "background",
    value: "#FFFFFF",
  },
  { name: "Surface", swatch: "bg-surface", token: "surface", value: "#F5F5F4" },
  { name: "Hairline", swatch: "bg-border", token: "border", value: "#E7E7E5" },
  {
    name: "Strong",
    swatch: "bg-border-strong",
    token: "border-strong",
    value: "#D1D1CE",
  },
  {
    name: "Graphite",
    swatch: "bg-muted-foreground",
    token: "muted-foreground",
    value: "#6B6B6B",
  },
  { name: "Subtle", swatch: "bg-subtle", token: "subtle", value: "#8A8A87" },
  {
    name: "Ink",
    swatch: "bg-foreground",
    token: "foreground",
    value: "#111111",
  },
  { name: "Accent", swatch: "bg-accent", token: "accent", value: "#F58827" },
] as const;

const STATUSES = [
  {
    dot: "bg-confirmed",
    hint: "Клиент сказал прямо",
    name: "Подтверждено",
    text: "text-confirmed",
  },
  {
    dot: "bg-assumption",
    hint: "Агент додумал, проверить",
    name: "Допущение",
    text: "text-assumption",
  },
  {
    dot: "bg-contradiction",
    hint: "Расходится со сказанным или с доками",
    name: "Противоречие",
    text: "text-contradiction",
  },
  {
    dot: "border border-empty",
    hint: "Ещё не обсуждали",
    name: "Пусто",
    text: "text-muted-foreground",
  },
] as const;

const SOFT = [
  {
    className: "bg-confirmed-soft text-confirmed",
    label: "подтверждено",
    token: "confirmed-soft",
  },
  {
    className: "bg-assumption-soft text-assumption",
    label: "допущение",
    token: "assumption-soft",
  },
  {
    className: "bg-contradiction-soft text-contradiction",
    label: "противоречие",
    token: "contradiction-soft",
  },
  {
    className: "bg-accent-soft text-accent-ink",
    label: "ждёт клиента",
    token: "accent-soft, accent-ink",
  },
] as const;

const TYPE_SCALE = [
  {
    className: "text-3xl font-semibold tracking-tight",
    sample: "Звонок с «Телемедиа» закончен",
    token: "3xl, 40/44, 600",
  },
  {
    className: "text-2xl font-semibold tracking-tight",
    sample: "Система приёма звонков",
    token: "2xl, 28/34, 600",
  },
  {
    className: "text-xl font-semibold tracking-tight",
    sample: "Открытые вопросы",
    token: "xl, 20/28, 600",
  },
  {
    className: "text-lg font-medium",
    sample: "Что происходит, если все операторы заняты?",
    token: "lg, 16/24, 500",
  },
  {
    className: "text-base",
    sample:
      "Клиент хочет принимать звонки с сайта и из рекламы в одну очередь.",
    token: "base, 14/20, 400",
  },
  {
    className: "text-sm text-muted-foreground",
    sample: "Не ясно поведение очереди при пиковой нагрузке",
    token: "sm, 13/18, 400",
  },
  {
    className: "font-mono text-xs text-muted-foreground",
    sample: "12:04, тема 2 из 3, открыто 4",
    token: "xs mono, 12/16",
  },
] as const;

const RADII = [
  {
    className: "rounded-full",
    hint: "Кнопки, пилюли, чипы, якоря",
    name: "full",
  },
  {
    className: "rounded-lg",
    hint: "Окна, плавающие панели, диалоги, главный вопрос",
    name: "lg, 26",
  },
  {
    className: "rounded-panel",
    hint: "Белая панель внутри окна",
    name: "panel, 20",
  },
  {
    className: "rounded-md",
    hint: "Карточки, вопросы, меню и поповеры",
    name: "md, 18",
  },
  { className: "rounded-sm", hint: "Поля ввода, пункты меню", name: "sm, 12" },
  {
    className: "rounded-xs",
    hint: "Плитки логотипов, блоки кода, подсказка",
    name: "xs, 8",
  },
] as const;

const SHADOWS = [
  {
    className: "shadow-touch rounded-md",
    hint: "Пузырь расшифровки, активный пункт навигации",
    name: "Касание",
  },
  {
    className: "shadow-card-sm rounded-md",
    hint: "Карточки контекста",
    name: "Карточка малая",
  },
  {
    className: "shadow-card rounded-md",
    hint: "Белая панель, карточки на страницах",
    name: "Карточка",
  },
  {
    className: "shadow-float rounded-lg",
    hint: "Диалоги, виджет, тосты, меню",
    name: "Плавающее",
  },
] as const;

export function FoundationsSection() {
  return (
    <ShowcaseSection
      description="Тихий инструмент для звонка. Всё чернила на белом; оранжевый появляется только там, куда менеджер должен посмотреть прямо сейчас."
      id="foundations"
      title="Основы"
    >
      <ShowcaseGroup title="Цвет">
        <div className="grid grid-cols-8 gap-4">
          {NEUTRALS.map((color) => (
            <div className="flex flex-col gap-2" key={color.token}>
              <div className={`h-16 rounded-sm ${color.swatch}`} />
              <div className="text-sm font-medium">{color.name}</div>
              <div className="text-muted-foreground font-mono text-xs">
                {color.token} {color.value}
              </div>
            </div>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Статусы">
        <div className="flex flex-wrap gap-12">
          {STATUSES.map((status) => (
            <div className="flex flex-col gap-1" key={status.name}>
              <div className={`flex items-center gap-2 text-sm ${status.text}`}>
                <span className={`size-1.5 rounded-full ${status.dot}`} />
                {status.name}
              </div>
              <div className="text-muted-foreground text-sm">{status.hint}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-12">
          {SOFT.map((soft) => (
            <div className="flex flex-col items-start gap-2" key={soft.label}>
              <span
                className={`rounded-full px-2 py-0.5 text-sm ${soft.className}`}
              >
                {soft.label}
              </span>
              <span className="text-muted-foreground font-mono text-xs">
                {soft.token}
              </span>
            </div>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Типографика">
        <div className="flex flex-col">
          {TYPE_SCALE.map((row) => (
            <div
              className="border-border flex items-baseline gap-8 border-b py-3 last:border-b-0"
              key={row.token}
            >
              <span className="text-muted-foreground w-36 shrink-0 font-mono text-xs">
                {row.token}
              </span>
              <span className={row.className}>{row.sample}</span>
            </div>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Скругления">
        <div className="grid grid-cols-6 gap-6">
          {RADII.map((radius) => (
            <Specimen caption={radius.hint} key={radius.name}>
              <div className={`bg-surface h-16 ${radius.className}`} />
              <div className="text-sm font-medium">{radius.name}</div>
            </Specimen>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Глубина">
        <div className="bg-surface grid grid-cols-4 gap-6 rounded-lg p-6">
          {SHADOWS.map((shadow) => (
            <Specimen caption={shadow.hint} key={shadow.name}>
              <div className={`bg-background h-16 ${shadow.className}`} />
              <div className="text-sm font-medium">{shadow.name}</div>
            </Specimen>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup title="Фокус">
        <div className="flex flex-wrap items-start gap-12">
          <Specimen caption="Кнопки, чекбоксы, навигация: зазор 2px и кольцо 2px #707070">
            <span className="bg-primary text-primary-foreground focus-ring inline-flex h-8 items-center self-start rounded-full px-3.5 text-sm font-medium">
              Начать звонок
            </span>
          </Specimen>
          <Specimen caption="Поля: рамка text и ореол 3px, 6%. В покое рамка border-strong">
            <span className="field-focus bg-background inline-flex h-10 w-60 items-center rounded-sm border px-3 text-base">
              Телемедиа
            </span>
          </Specimen>
        </div>
      </ShowcaseGroup>
    </ShowcaseSection>
  );
}
