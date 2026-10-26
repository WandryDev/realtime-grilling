# UI-референсы (Mobbin)

> Собрано 2026-10-19. Картинки лежат в `docs/references/<экран>/` (ссылки на изображения Mobbin живут 30 дней). Канонические ссылки — mobbin_url.
> Направление дизайна: минимализм «Ink, paper, one highlighter» — см. Paper-файл «Grill — Call Assistant».

## Звонок

# Референсы для экранов во время звонка (29 изображений, все проверены)

Все 29 файлов скачаны и проверены командой `file`: это валидные WebP, в основном 1920×1320 (web) и 1179×2676 (iOS). Лежат в `/Users/dev_wandry/projects/client-grilling/docs/references/01…05-*/`.

Granola на Mobbin есть только в iOS-версии, десктопной нет. Gong, Fathom, tl;dv, Cluely, Read.ai и Krisp в поиске не нашлись. Самые близкие по смыслу примеры дали Fireflies (Live Assist), Tana (Meeting Agent), Dialpad, Otter и Zoom AI Companion.

## 01 — Виджет начала звонка
- [Loom — компактная плавающая панель записи](https://mobbin.com/screens/4740cd47-97d9-4014-a602-8f1fff95f6ee). Взять стек строк «источник / камера / микрофон» с переключателями и одну крупную кнопку Start: это готовая структура «проект + участники + Start». `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/loom-1.webp`
- [Asana — popover записи в углу](https://mobbin.com/screens/ac005a29-3aa7-41a0-b581-98091220c61a). Взять компактные строки-селекты (иконка + значение + шеврон) и неактивную кнопку старта, пока что-то не выбрано. `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/asana-1.webp`
- [Apollo — диалог «Record an impromptu meeting»](https://mobbin.com/screens/229f6eb6-4cb8-4700-b2d3-22b65bf292e7). Взять поле «Add meeting participants» (выбор или ввод email) с подсказкой и пару кнопок Cancel / Record now. `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/apollo-1.webp`
- [Grain — плашка «Recorder in waiting room» и карточка «Now»](https://mobbin.com/screens/844f3073-4e64-4f18-88c8-cab0a28b04e2). Взять тонкую верхнюю плашку с названием встречи и кнопками Cancel / Join, а также инлайн-дропдауны (Template, Access) рядом с Start Recording. `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/grain-1.webp`
- [Tolan (iOS) — тёмная call-пилюля](https://mobbin.com/screens/8b570236-6c4f-4fe4-8424-e7984d913a6f). Взять форму уведомления-пилюли (аватар, таймер, круглые действия) для свёрнутого варианта «Meeting detected». `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/tolan-ios-1.webp`
- [Riverside — тёмный popover настроек записи](https://mobbin.com/screens/6372d689-bd21-43d1-808a-e043e9cd97c4). Взять тёмную сетку «лейбл слева, селект справа», хорошо подходит для тёмной темы виджета. `/Users/dev_wandry/projects/client-grilling/docs/references/01-call-start-widget/riverside-1.webp`

## 02 — Оверлей / боковая панель во время звонка
- [Fireflies — AskFred «Suggest Questions» и Live Assist](https://mobbin.com/screens/2047129f-d283-45ef-81bb-09aa79a32ffe). Самый близкий аналог: короткий список вопросов, у каждого жирная формулировка и строка «почему», плюс статус «Live Assist is listening». `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/fireflies-1.webp`
- [Tana — LiveDigest и Talking Points во время звонка](https://mobbin.com/screens/3f941670-2958-455e-8afa-f1212baaefc7). Взять колонку тем разговора («Following Along», текущая тема выделена) рядом с блоками пунктов, а также спокойные полупрозрачные карточки. `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/tana-1.webp`
- [15Five — «Suggested talking points»](https://mobbin.com/screens/414fd249-4808-4ec4-8724-44f831bd7e3b). Взять карточку «вопрос + мелкая метка категории внизу»: метка категории здесь — это тема, она же может быть меткой «ClickUp». `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/15five-1.webp`
- [Grammarly — панель Review suggestions](https://mobbin.com/screens/b727d76e-6475-4a20-a8bd-d0ad05569b30). Взять цветные табы-категории с полоской сверху (это темы) и одну подсказку в фокусе. `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/grammarly-1.webp`
- [WRITER — список предложений с категориями](https://mobbin.com/screens/9b5aa3ca-df82-4c8f-a268-f2b5d6e1e258). Взять правую колонку «цветная точка + тема + счётчик / галочка»: это готовый индикатор покрытия тем. `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/writer-1.webp`
- [Granola (iOS) — нижний бар записи](https://mobbin.com/screens/e96bd18e-eec7-49cf-87c3-ff38ab46a47e). Взять минимальный контрол-бар: пауза, таймер, зелёный индикатор уровня звука, End. Хорошо подходит для шапки или футера оверлея. `/Users/dev_wandry/projects/client-grilling/docs/references/02-in-call-overlay/granola-ios-1.webp`

## 03 — Живой транскрипт (Я / Они)
- [Dialpad — панель Transcripts во время звонка](https://mobbin.com/screens/3993ae4d-c423-4e1a-a6e6-2901710edf88). Взять узкую панель живого транскрипта рядом со звонком и статус «Listening» с анимированными точками. `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/dialpad-1.webp`
- [Fireflies — транскрипт с цветными спикерами](https://mobbin.com/screens/b7b4cfbb-afd6-49c0-928a-8692e2354ae7). Взять цветной квадрат-инициал спикера, кликабельный таймкод и подсветку текущей реплики. `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/fireflies-1.webp`
- [Truecaller (iOS) — транскрипт звонка ассистента](https://mobbin.com/screens/62ff71fe-6b1c-4964-8b5f-2dc97e91d872). Взять асимметрию: собеседник крупным текстом без пузыря слева, «я» в пузырях справа. Каналы Me и Others различаются сразу, без подписей. `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/truecaller-ios-1.webp`
- [Sana AI — компактный транскрипт с таймкодами](https://mobbin.com/screens/bf5953e7-235c-42d6-8368-bd23ba059102). Взять плотный список «таймкод + строка», где текущая строка тёмная, а прошедшие серые, и кнопку «Scroll for more». `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/sana-ai-1.webp`
- [Granola (iOS) — шит Transcript](https://mobbin.com/screens/2ab4ec98-0de2-40ee-87b5-a30d7cbcd58b). Взять минимализм в стиле Granola: цветной аватар-буква (Speaker A / B), жирное имя, серый текст реплики. `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/granola-ios-1.webp`
- [Fabric (iOS) — живой текст над баром записи](https://mobbin.com/screens/325b348f-5710-41f7-a879-dd9e18c494b3). Взять бегущий фрагмент транскрипта прямо над тёмной пилюлей записи: так выглядит мини-транскрипт в свёрнутом оверлее. `/Users/dev_wandry/projects/client-grilling/docs/references/03-live-transcript/fabric-ios-1.webp`

## 04 — «Final check» в конце встречи
- [Tana — «Ends in 4 minutes · Wrap up»](https://mobbin.com/screens/416e64e7-008c-49a3-8fa4-e8edf6c438b3). Взять жёлтый чип «Wrap up» и оранжевый текст «Ends in N minutes» в шапке как триггер для final check. `/Users/dev_wandry/projects/client-grilling/docs/references/04-final-check/tana-1.webp`
- [15Five — чек-лист Talking points](https://mobbin.com/screens/f399341d-6357-40e4-bcf2-4e64e5d20e21). Взять отмеченные и неотмеченные пункты с мета-строкой «Added by…» (её можно заменить на тему или «from ClickUp») и кнопку «End 1-on-1» внизу. `/Users/dev_wandry/projects/client-grilling/docs/references/04-final-check/15five-1.webp`
- [Klaviyo — Review submission](https://mobbin.com/screens/02359910-64f7-4f23-8280-f1bf18c8e95f). Взять список со статус-иконками (красный — блокер, жёлтый — предупреждение, зелёный — закрыто) и строкой пояснения под каждым пунктом. Это прямая модель «важное, но не спрошено». `/Users/dev_wandry/projects/client-grilling/docs/references/04-final-check/klaviyo-1.webp`
- [Dovetail — инсайты «By topics»](https://mobbin.com/screens/3e756eeb-c1b0-470f-a123-30a17ab68a28). Взять группировку пунктов под жирными заголовками тем в узкой правой колонке. `/Users/dev_wandry/projects/client-grilling/docs/references/04-final-check/dovetail-1.webp`
- [Revolut Business — «Verify details / Requires action»](https://mobbin.com/screens/874b18b7-720b-45eb-aeee-3ad124804e1f). Взять тёмный вариант: группы карточек, у каждого пункта оранжевый подзаголовок «Requires action». `/Users/dev_wandry/projects/client-grilling/docs/references/04-final-check/revolut-business-1.webp`

## 05 — Запрос на завершение звонка (обратный отсчёт)
- [Google Meet — «Are you still there?»](https://mobbin.com/screens/3b28d725-7b38-4f7c-821d-5438729797fb). Почти точная копия нашего сценария: таймер-бейдж 1:49, текст «call will end in less than 2 minutes» и кнопки «Leave now / Stay in the call». `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/google-meet-1.webp`
- [Revolut Business — истечение сессии](https://mobbin.com/screens/1cdd71c1-8987-414d-82f6-edfc4ec9f77e). Взять кольцевой прогресс с цифрами в центре и две кнопки на всю ширину: «Keep» основная, «End» вторичная. `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/revolut-business-1.webp`
- [AutoSend — «almost live» с отсчётом](https://mobbin.com/screens/305e4f89-9a51-490f-aa09-7b9dff264b37). Взять инлайн-таймер внутри фразы («через 1m 58s») и разделённые кнопки Abort / OK. `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/autosend-1.webp`
- [Opal (iOS) — тёмная live-activity с таймером](https://mobbin.com/screens/c4b08830-1f6d-4da7-9e69-7d029abc4bb6). Взять компактную тёмную карточку: таймер справа сверху и одно широкое действие. Это вариант тоста без модалки. `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/opal-ios-1.webp`
- [Hotjar — «Are you sure you want to end this session?»](https://mobbin.com/screens/d0133efc-c44e-4a34-b989-79beb9c42cb2). Взять формулировку последствий («запись остановится, заметки будут доступны») и пару «Continue session / End session». `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/hotjar-1.webp`
- [Fireflies — тост после остановки записи](https://mobbin.com/screens/06beaaec-7230-418a-a161-c28fbb74da66). Взять тёмный тост внизу с галочкой: это подтверждение после автозавершения. `/Users/dev_wandry/projects/client-grilling/docs/references/05-end-call-prompt/fireflies-1.webp`

---

**Your Mobbin AI usage is high this month**

Usage is unlimited during beta. If your usage stays at this level, you may need to purchase more credits once limits take effect. [View usage and plan options](https://mobbin.com/settings/billing-and-usage)


## После звонка

# Референсы: экраны после звонка и история (06–10)

Собрал 30 референсов, по 6 на каждый из 5 экранов. Все файлы скачаны в WebP 1920×~1320, `file` подтвердил, что это валидные изображения. Базовая папка: `/Users/dev_wandry/projects/client-grilling/docs/references/`.

Прямых аналогов двух вещей на Mobbin нет: «карточки-спецификации со статусом на каждом поле» (подтверждено / предположение / противоречие / пусто) и «предложенных правок к брифу». Для экрана 08 карточку придётся собирать из нескольких паттернов, примеры ниже.

## 06 — Итоги звонка

- [Calendly — recap встречи: Summary, Action items, Discussion + боковая панель Details/Attendees](https://mobbin.com/screens/6fc83e69-b982-4945-bc3d-462e50aebfb7). Взять: каждый раздел итогов в отдельной карточке с меню «…», справа колонка с метаданными звонка (дата, время, участники). Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/calendly-1.webp`
- [Grain — Meeting Summary: Purpose, Chapters, Outcomes, Action Items](https://mobbin.com/screens/491a75cd-4c36-4ca3-b9c3-2bb5c7d7a8d6). Взять: таймкод справа у каждого пункта, чтобы перейти к месту в транскрипте; вкладки Summary / Chapters / Transcript. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/grain-1.webp`
- [Otter — Overview + Outline, вкладки Summary/Transcript, справа AI-чат](https://mobbin.com/screens/56ea7686-8741-49d5-8f5e-ef4b6e7de71e). Взять: короткий абзац Overview как TL;DR и под ним структурированный Outline по темам; метаданные строкой под заголовком. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/otter-1.webp`
- [Fireflies — General Summary и слева AI Filters (Questions 12, Tasks 5)](https://mobbin.com/screens/6d5394df-632e-4f38-a81a-f015c85a55a5). Взять: фильтры-счётчики слева для «открытых вопросов» и тем; переключатель типа саммари. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/fireflies-1.webp`
- [Amie — шапка заметки встречи со свойствами (Created/Meeting/Audio) и вкладки](https://mobbin.com/screens/a95f3fde-46f6-4746-bd8d-22ecfa3748f8). Взять: минималистичная шапка в стиле Granola из пар «ключ — значение» и вкладки Private notes / Summary / Transcript. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/amie-1.webp`
- [Apollo — Insights: карточки Outcome / Next Steps / Objections](https://mobbin.com/screens/3576f608-832c-46b3-bfc3-8f8f9e0332f7). Взять: отдельная карточка на смысловой блок («4 sections generated»), фидбэк «полезно ли саммари». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/06-post-call-summary/apollo-1.webp`

## 07 — Ревью предложенных AI правок

- [Grammarly — Review suggestions: карточка правки с Accept / Dismiss](https://mobbin.com/screens/e36b29ab-aa62-43dc-983c-596aefe06506). Взять: очередь карточек «зачёркнутое старое → жирное новое» с кнопками Accept/Dismiss и счётчик оставшихся правок. Это ближайший аналог принятия правок по одной. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/grammarly-1.webp`
- [Langdock — inline-diff прямо в документе с ✓/✕](https://mobbin.com/screens/879416cc-ee0b-42c9-999b-3f829c041b12). Взять: красное (удалено) и зелёное (предложено) в тексте брифа, маленькие кнопки ✓/✕ у фрагмента. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/langdock-1.webp`
- [Arcade — Review changes: таблица Before → After с чекбоксами](https://mobbin.com/screens/b850abdb-2418-47b3-adaf-eac362756c6d). Взять: для полей профиля клиента: колонки «поле / было / станет», чекбокс на каждую строку, «12 of 12 selected» и Confirm changes. Пустое значение показано как «(empty)». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/arcade-1.webp`
- [Snowflake CoCo — блоки изменений с Undo/Keep и «Keep all», навигация «1 of 3»](https://mobbin.com/screens/f63ee0d2-39f5-4d48-a6d5-cd8dccff64a4). Взять: Undo/Keep на каждом блоке, общая плашка «Changed 1 file · Undo · Keep all» и переход между правками. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/snowflake-1.webp`
- [Linear — история версий документа с подсветкой изменений](https://mobbin.com/screens/6c14e085-9ff5-4e61-9a21-b04f1b0a3433). Взять: аккуратная типографика диффа (зачёркивание серым, добавленное с фоновым выделением), вертикальная полоса слева у изменённого абзаца, тоггл «Highlight changes». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/linear-1.webp`
- [Peec AI — таблица рекомендаций с ✕/✓ в каждой строке](https://mobbin.com/screens/a33f472c-a45f-4a1d-bcab-6aa85d66c70e). Взять: компактный список-очередь, у каждой строки теги типа и иконки принять/отклонить; вкладки Todo / History для разобранных. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/07-review-suggestions/peec-ai-1.webp`

## 08 — Карточка задачи со статусом каждого поля

- [Rox — карточка сделки: список свойств с иконками, пилюля стадии, пустые поля как плейсхолдеры](https://mobbin.com/screens/d4ddd4b3-a1b9-4190-bbb9-c33de1d5b02a). Взять: колонку «иконка + метка + значение»; пустые поля серым плейсхолдером («Enter next step»). Подходит для статуса «пусто». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/rox-1.webp`
- [Twenty — поля записи, сгруппированные в сворачиваемые секции (General/Business/Contact)](https://mobbin.com/screens/f0170497-9df6-4b27-9bdc-ab606ee77530). Взять: группировку полей карточки (цель, пользователи, сценарии, edge cases, интеграции…) в секции с заголовками. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/twenty-1.webp`
- [Contra — форма, где поля, заполненные AI, помечены AI-бейджем](https://mobbin.com/screens/98661b15-dcd2-4bd0-9744-9d3a38e6d3e3). Взять: маленький маркер у метки поля плюс баннер «проверьте, что сгенерировал AI». Подходит для статуса «предположение». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/contra-1.webp`
- [Miro — Card details: поля с цветными бейджами статуса](https://mobbin.com/screens/697d7003-c704-41fb-bbaa-741ef192ca4f). Взять: компактную карточку «метка: значение» с бейджем статуса (✓ Done) и превью той же карточки на канвасе. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/miro-1.webp`
- [Adaline — сворачиваемые пункты с пилюлей «Completed» и подпунктами](https://mobbin.com/screens/36261cc6-0b4a-4cd5-a957-e679828ec74f). Взять: пункт-строку с иконкой статуса слева и пилюлей справа; раскрытие показывает детали и источники. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/adaline-1.webp`
- [Revolut Business — Verify details: у каждого пункта «Requires action» с иконкой-предупреждением](https://mobbin.com/screens/874b18b7-720b-45eb-aeee-3ad124804e1f). Взять: подпись статуса под названием и бейдж на иконке. Подходит для статуса «противоречие / требует внимания». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/08-task-card/revolut-business-1.webp`

## 09 — История звонков

- [Grain — список встреч, сгруппированный по дням (Today/Yesterday)](https://mobbin.com/screens/4e4bddd0-8458-4640-9ca7-c147077a3145). Взять: плотную строку «название, дата · длительность, владелец, число участников, счётчики» и группировку по датам. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/grain-1.webp`
- [Fireflies — Meeting Status: список со статусами обработки](https://mobbin.com/screens/9f09cb91-41ed-4a33-86a8-4628763c3b29). Взять: статус-пилюлю справа (Completed / ошибка) и фильтры по диапазону дат и статусу. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/fireflies-1.webp`
- [Otter — лента встреч карточками с превью саммари](https://mobbin.com/screens/9883e784-a44b-422e-8c00-13fc51059f37). Взять: вариант списка с 3–4 строками саммари в каждой карточке, «Show more» и группировку по дням. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/otter-1.webp`
- [Apollo — таблица записанных встреч (тёмная тема)](https://mobbin.com/screens/be69d64f-37fe-48f4-969d-cda09a3ac1f8). Взять: табличный режим с длительностью на миниатюре, колонками дата / host / участники и быстрыми действиями в строке. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/apollo-1.webp`
- [Hume AI — Chat history: время, статус, длительность, оценочные теги](https://mobbin.com/screens/0fc3643f-ecb6-435b-8146-680f7480ff64). Взять: в колонке статуса сразу две строки, «завершено» и «N событий · M минут», плюс цветные теги-оценки. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/hume-ai-1.webp`
- [Aboard — слева список Upcoming/Completed, справа детали встречи](https://mobbin.com/screens/90836426-38ae-4a1f-9e11-917d1ad69b4a). Взять: master-detail раскладку для десктопа и шапку деталей (Meeting, Duration, Status: Completed, Attendees). Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/09-call-history/aboard-1.webp`

## 10 — Детали звонка: полный транскрипт

- [Otter — транскрипт: аватар спикера, имя, таймкод, плеер снизу](https://mobbin.com/screens/01981d27-dce2-4dce-a344-3cb6185da831). Взять: реплику с цветным аватаром, именем и таймкодом, подсветку текущего слова, закреплённый плеер и «Edit Transcript». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/otter-1.webp`
- [Fireflies — саммари по центру, транскрипт в правой колонке](https://mobbin.com/screens/61d8e7bd-c468-479f-9752-3004ce68c345). Взять: две колонки «саммари ↔ транскрипт» с кликабельными таймкодами, поиск по транскрипту и плеер внизу на всю ширину. Это прямой вариант связки «саммари + транскрипт». Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/fireflies-1.webp`
- [Lightfield — транскрипт без видео + панель Meeting details/Participants](https://mobbin.com/screens/e19e1501-342e-4929-b079-2af68df911ff). Взять: чистую аудио-раскладку без видео, как у нас: имя слева, таймкод справа; вкладки Overview / Transcript и поле «Ask» внизу. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/lightfield-1.webp`
- [Maze — AI-саммари со ссылками-таймкодами (0:03, 1:59) рядом с транскриптом](https://mobbin.com/screens/ced395e9-7221-429e-8e37-a921d5ad215c). Взять: таймкоды прямо внутри текста саммари, которые ведут в транскрипт, и создание хайлайта из выделенного текста. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/maze-1.webp`
- [Grain — транскрипт + таймлайн talk-time по спикерам](https://mobbin.com/screens/7cb848ca-7570-47e3-ae14-675a636ce386). Взять: дорожки «кто когда говорил» с процентом времени и поповер Comment/Clip на выделенном тексте. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/grain-1.webp`
- [Sana AI — компактный транскрипт: таймкод колонкой слева + поиск](https://mobbin.com/screens/bf5953e7-235c-42d6-8368-bd23ba059102). Взять: плотный вид, где таймкоды выровнены в отдельную колонку, текущая реплика выделена, а остальные приглушены. Файл: `/Users/dev_wandry/projects/client-grilling/docs/references/10-call-detail-transcript/sana-ai-1.webp`

---

**Your Mobbin AI usage is high this month**

Usage is unlimited during beta. If your usage stays at this level, you may need to purchase more credits once limits take effect. [View usage and plan options](https://mobbin.com/settings/billing-and-usage)


## Настройка и проекты

# Референсы: настройка, проекты и настройки (экраны 11–18)

Все пути ниже указаны относительно `/Users/dev_wandry/projects/client-grilling/docs/references/`. Все 46 файлов — WebP примерно 1920×1320, команда `file` подтвердила, что это изображения.

Поиск шёл по web-платформе Mobbin. Экранов самого Granola там нет: по запросу «Granola» приходили только похожие сервисы для звонков (Fireflies, Grain, Tana, Otter). Десктопной формы окна (macOS/Windows) тоже почти нигде нет, поэтому из референсов берём паттерны, а оболочку окна делаем по-десктопному сами.

## 11 — Онбординг и системные разрешения
- [Tana — карточка «Turn on your mic and camera»](https://mobbin.com/screens/55dad85f-97df-4a49-9a76-cbc1ceddf713) — список разрешений с иконкой и строкой «зачем это нужно» у каждого и одна общая кнопка «Allow». — `11-onboarding-permissions/tana-1.webp`
- [Loom — запись экрана в macOS](https://mobbin.com/screens/2fb07a57-f5f8-4804-9342-c19af26b592d) — скриншот System Settings → Screen Recording, инструкция по шагам и кнопка «I have updated…» для повторной проверки. Точная модель нашего шага с записью экрана и системного звука. — `11-onboarding-permissions/loom-1.webp`
- [Maze — модалка «Allow microphone & camera recording»](https://mobbin.com/screens/1dc25cfe-d879-4e16-9545-4bbb744396ee) — картинка, которая показывает, куда нажать в системном диалоге, и сноска «эти разрешения обязательны». — `11-onboarding-permissions/maze-1.webp`
- [Dropbox Dash — шаг онбординга](https://mobbin.com/screens/dd58254c-c915-4015-8b7b-4908e86dd35f) — каркас пошагового мастера: контент слева, иллюстрация справа, внизу «назад», точки прогресса и «Continue». — `11-onboarding-permissions/dropbox-dash-1.webp`
- [Hume AI — пустое состояние «Microphone access is required»](https://mobbin.com/screens/bc155ede-07de-437a-a7c1-602855e8a843) — как вернуть пользователя к разрешению, если он его не дал, уже внутри приложения. — `11-onboarding-permissions/hume-ai-1.webp`

## 12 — Чеклист готовности окружения
- [HoneyBook — «Let's start step-by-step»](https://mobbin.com/screens/7c915d6b-2a99-4eb0-956d-e7a3a97bb265) — строки чеклиста с зелёными галочками, счётчик «6/7 completed» и полоса прогресса в шапке. — `12-env-setup-checklist/honeybook-1.webp`
- [Salesforce — шаги с кнопкой Verify](https://mobbin.com/screens/b4e0bf92-3173-4410-a92b-12aedd4d9178) — нумерованная проверка с кнопкой «Verify», текстом «Last checked… Status: Error» и ошибкой прямо в строке. Подходит для состояния «missing + Fix». — `12-env-setup-checklist/salesforce-1.webp`
- [AWS — статус загрузки](https://mobbin.com/screens/d0b2a1fa-99a9-4c29-ba83-f77a3f850d40) — у каждого пункта свой статус (Succeeded / In progress 58% / Pending), сверху общий прогресс со скоростью и оставшимся временем. Подходит для скачивания модели. — `12-env-setup-checklist/aws-1.webp`
- [Uvodo — «Let's get you started!»](https://mobbin.com/screens/d1e35f61-e3b8-482e-8f1d-99e4a9ccc611) — компактная карточка: пройденные пункты приглушены, текущий выделен, полоса прогресса над списком. — `12-env-setup-checklist/uvodo-1.webp`
- [Dropbox — «99% · 41 KB out of 41 KB»](https://mobbin.com/screens/fdbf5d80-fad7-4f13-92c1-634f429f10b4) — крупный процент, подпись «X из Y» и «Cancel». Готовое состояние для загрузки речевой модели. — `12-env-setup-checklist/dropbox-1.webp`
- [Revolut Business — «Requires action»](https://mobbin.com/screens/874b18b7-720b-45eb-aeee-3ad124804e1f) — список с оранжевым бейджем «Requires action» и шевроном. Тёмный вариант пунктов, где чего-то не хватает. — `12-env-setup-checklist/revolut-business-1.webp`

## 13 — Интеграции (карточки, API-ключ, вход по коду устройства)
- [Rox — Integrations](https://mobbin.com/screens/2820d9c1-11bc-4134-9274-87035d73da60) — две группы «Current / Not connected», бейдж «Connected», на подключённых строка «Last synced 2 min ago» и кнопки настроек и удаления. — `13-integrations/rox-1.webp`
- [Unify — список интеграций](https://mobbin.com/screens/6717566f-1d46-4fb0-8432-8f7554342584) — строки по категориям, справа зелёный «● Connected» или кнопка «Connect», тост об успешном подключении. — `13-integrations/unify-1.webp`
- [LangChain Fleet — интеграции](https://mobbin.com/screens/c3ee2df7-4268-4daa-a45d-194770781ec6) — три статуса-пилюли: «Connected», «Missing scopes» и кнопка «Connect». Пригодится для частично настроенного GitHub или ClickUp. — `13-integrations/langchain-1.webp`
- [Twingate — модалка «Connect 1Password»](https://mobbin.com/screens/e15687ca-e18a-4e48-bb16-9f25e709c757) — поле API key с кнопкой «показать», ошибка «Unauthorized…» в рамке и крупная кнопка «Connect». Это наш ввод ключа Outline. — `13-integrations/twingate-1.webp`
- [Bolt.new — «Enter your Stripe API key»](https://mobbin.com/screens/7538011a-4f52-4c28-826a-3c044cab8203) — блок «Where can I find my API key?» со ссылкой. Это важно для нетехнических менеджеров. — `13-integrations/bolt-1.webp`
- [Surfshark — вход по коду](https://mobbin.com/screens/3a74cec1-d7f4-4f63-995e-8207688066aa) — код по символам в ячейках, кнопка «Copy», путь «Settings › My account › Enter login code», таймер «Code refreshes in 05:00». Ближе всего к экрану GitHub device flow. — `13-integrations/surfshark-1.webp`
- [Paramount+ — «Enter the activation code»](https://mobbin.com/screens/6aad85b9-86a5-46b3-8015-dadfa1070500) — крупная моноширинная подача кода с иллюстрацией устройства. — `13-integrations/paramount-1.webp`
- [Docusign — ожидание](https://mobbin.com/screens/ff8a6a18-9ace-4fc6-81a8-e32c7f170d0c) — «Keep this window open and follow the browser instructions» и спиннер. Состояние, пока ждём подтверждения на github.com. — `13-integrations/docusign-1.webp`
- [Lovable — авторизация GitHub OAuth](https://mobbin.com/screens/b9cff604-859b-4a77-8568-c47ac5269137) — визуальная связка «наше приложение ✓ GitHub» и список запрашиваемых прав. — `13-integrations/lovable-1.webp`

## 14 — Главная: проекты и недавние звонки
- [Fireflies — Home](https://mobbin.com/screens/6d457725-4850-44d2-b100-060adc93fab9) — приветствие, ряд карточек-сводок и под ними «Recent Meetings» с аватаром и временем. — `14-home-projects/fireflies-1.webp`
- [Grain — Meetings](https://mobbin.com/screens/12251095-9692-4035-b44a-81bda273c740) — список звонков, сгруппированный по «Today / Yesterday»: длительность, участники, меню «⋯». — `14-home-projects/grain-1.webp`
- [Vercel — Projects](https://mobbin.com/screens/a2712ef7-4a59-4778-9f85-12a6abb7a008) — сетка карточек проектов с иконкой статуса и метаданными, слева колонка с алертами и недавним. — `14-home-projects/vercel-1.webp`
- [Rox — «Here's your focus for today»](https://mobbin.com/screens/62b4d10c-498e-49eb-bf78-3b944290f407) — справа блок «Today · Meeting with client · Follow Up». Хорошее место для ближайшего звонка. — `14-home-projects/rox-1.webp`
- [Riverside — Projects (тёмная тема)](https://mobbin.com/screens/20933911-0b7c-4db0-9b95-71f0ae55b9fe) — ряд быстрых действий (Plan / Record / Upload…) над сеткой проектов. Пример тёмной темы. — `14-home-projects/riverside-1.webp`

## 15 — Мастер добавления проекта
- [Obvious — «Create Folio · Data Sources (optional)»](https://mobbin.com/screens/bdf1b167-84fd-4d41-9046-5147ddd9b1f4) — компактная модалка с точками-шагами, поиском и чекбоксами документов. Подходит для выбора коллекции Outline. — `15-add-project/obvious-1.webp`
- [Graphite — «Select repos to sync»](https://mobbin.com/screens/a9947500-6b74-4c78-8455-0d528f3e7764) — список репозиториев с чекбоксами, поиском, счётчиком «0 of 30» и «Clear all». — `15-add-project/graphite-1.webp`
- [Render — «Connect a repository»](https://mobbin.com/screens/6362a411-6e89-4b95-878f-0c289d02b3ce) — репозитории с кнопкой «Connect» в каждой строке, справа провайдеры и «Configure account». — `15-add-project/render-1.webp`
- [Greptile — «Let's start by connecting your GitHub»](https://mobbin.com/screens/4f1f9075-d1bf-48ad-a3dd-4a8daff8d544) — подшаги 1/2/3 внутри шага, «Awaiting code provider connection», Back/Next с горячими клавишами. — `15-add-project/greptile-1.webp`
- [Deel — мастер с панелью шагов](https://mobbin.com/screens/216c372c-82e4-45af-91bb-d84987824035) — справа список шагов со статусом «Completed», у источников бейдж «Connected», выбор чекбоксом. — `15-add-project/deel-1.webp`
- [Snowflake — модалка «New evaluation run»](https://mobbin.com/screens/af2d747c-50f5-4e38-ad42-8f3032d34ed5) — большая модалка-мастер: шаги слева, форма справа, внизу Cancel/Previous/Next. — `15-add-project/snowflake-1.webp`

## 16 — Страница проекта: бриф, источники, люди
- [Linear — обзор проекта](https://mobbin.com/screens/344cad59-d4a8-421a-9c2f-14b3c977e82d) — шапка со свойствами (статус, люди, ресурсы), длинное описание и правая колонка с Properties и прогрессом. Каркас «бриф + метаданные». — `16-project-page/linear-1.webp`
- [Gemini Notebook — Sources + Chat](https://mobbin.com/screens/cff41183-6331-4803-a6ae-9b8cbe7c6352) — панель «Sources» с чекбоксами и «Add sources», рядом сгенерированная сводка с пометкой «8 sources». — `16-project-page/gemini-notebook-1.webp`
- [Asana — AI summary](https://mobbin.com/screens/de177dce-059a-4a3f-870f-1a500e38070f) — блок «AI summary» с кнопкой «Generate summary», ниже «Project roles» с аватарами и «Add member». — `16-project-page/asana-1.webp`
- [Grok — проект](https://mobbin.com/screens/bf46cdb7-b7b4-4ad7-a339-9114880a8a36) — карточки «Instructions» и «Sources» в колонке проекта. Подходит для заметок и источников брифа. — `16-project-page/grok-1.webp`
- [HoneyBook — страница проекта](https://mobbin.com/screens/15790c8a-47c2-4600-a012-edc3b466c120) — ряд участников со стороны клиента (аватар + «CONTACT» + «Add») под заголовком и вкладки Activity/Files/Notes. — `16-project-page/honeybook-1.webp`

## 17 — Профиль человека
- [Attio — запись](https://mobbin.com/screens/d76ba56f-98c3-463f-9e1d-bbe4831ee47a) — правая панель «Record details» с цветными тегами, приоритетом и звёздами «Close confidence». Годится для шкал «техграмотность» и «понимание проекта». — `17-person-profile/attio-1.webp`
- [Clay — человек](https://mobbin.com/screens/a1283d6d-b8c3-4918-8a1a-06a9b6917abd) — шапка с аватаром и цветными чипами под именем, «Network strength: Low», группы-теги справа. — `17-person-profile/clay-1.webp`
- [HubSpot — контакт](https://mobbin.com/screens/f215a882-8c79-4bf8-8483-4d8ae465c3c1) — AI-блок «Contact summary» с кнопкой «Ask a question». Аналог сгенерированного портрета человека. — `17-person-profile/hubspot-1.webp`
- [Unify — «Person Details»](https://mobbin.com/screens/f7fdd3d8-cef4-4f1e-a05d-533fbe52e145) — карточка человека с блоком «Key Questions» для звонка. Очень близко к нашей идее. — `17-person-profile/unify-1.webp`
- [Twenty — человек](https://mobbin.com/screens/9393b3fd-e5f3-40d3-87fd-dcfa9b4b3a66) — поля, сгруппированные по секциям (General / Work / Social) со сворачиванием, справа лента изменений. — `17-person-profile/twenty-1.webp`

## 18 — Настройки
- [Dialpad — App Preferences](https://mobbin.com/screens/f672a5ee-aa70-4709-be44-4cb2b65da073) — окно настроек в духе десктопного приложения: выбор микрофона и динамика, ползунок, индикатор уровня, «Test», номер версии внизу. — `18-settings/dialpad-1.webp`
- [Discord — Voice & Video](https://mobbin.com/screens/dbb26083-0d44-4d90-9498-c07ee9df7a21) — устройства ввода и вывода рядом, громкость, «Mic Test» с индикатором уровня и порог чувствительности. — `18-settings/discord-1.webp`
- [Microsoft Teams — General](https://mobbin.com/screens/f6904629-5f3e-4ce0-9fff-a2524964b383) — настройки карточками-строками (селект или тумблер справа) и блок хранилища с полосой «<0.1 GB of 5 GB». — `18-settings/microsoft-teams-1.webp`
- [Graphite — Preferences](https://mobbin.com/screens/102736c8-9a2a-4185-a155-025f1c0b3217) — плотные строки «название + описание + контрол» с разделителями секций. Подходит для блока агента и тайм-аута автозавершения. — `18-settings/graphite-1.webp`
- [Skiff — модальное окно настроек](https://mobbin.com/screens/4a049dcf-b1c8-460f-9bc7-70ed8ab89cb1) — компактное окно с боковой навигацией по группам (включая Storage). Хорошая пропорция для десктопа. — `18-settings/skiff-1.webp`

---

**Your Mobbin AI usage is high this month**

Usage is unlimited during beta. If your usage stays at this level, you may need to purchase more credits once limits take effect. [View usage and plan options](https://mobbin.com/settings/billing-and-usage)
