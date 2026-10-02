# تحویل به فرانت‌اند: پنل Admin و پنل Seller (پیش‌نمایش شروع کدنویسی)

| | |
|---|---|
| تاریخ | ۱ اکتبر ۲۰۲۶ |
| مخاطب اصلی | مهدی (Frontend) |
| هم‌خوان‌ها | هادی (Product Owner)، رضا (UI/UX)، جعفر (Product Designer)، سجاد (QA) |
| منبع طراحی | فایل Figma **«MondaPac Design System»** (منبع حقیقت، ADR-0017). بوم «MondaPac Panel Shell»، صفحهٔ **Final — A + C components** فقط پیش‌نمایش مرجع است. |
| توکن‌ها | `docs/design/tokens/`: شش فایل DTCG (`primitives`، `color.light`، `color.dark`، `dimension.desktop`، `dimension.touch`، `typography`) و `tokens.css` (متغیرهای `--mp-*`). خروجی دستور Export tokens افزونهٔ Figma است. |
| وضعیت | **پیش‌نمایش.** ظاهر A تأیید شده است. کامپوننت‌های هر ماژول بعداً مرحله‌به‌مرحله با صاحب پروژه طراحی و تکمیل می‌شوند. صفحه‌های هر ماژول فقط پس از G1 همان ماژول ساخته می‌شوند (ADR-0013). |

---

## ۱. نمای کلی

- **تصمیم صاحب پروژه:** ظاهر **A** (سفید، کارت با حاشیه، IBM Plex Sans، آبی `#1D4FD7`) تأیید شد.
- این کامپوننت‌ها از جهت C با همان ظاهر A آمده‌اند:
  - نمودار روند با مقایسه
  - شاخص با sparkline
  - صف بازبینی با مهلت و نوار زمان
  - اقدام گروهی شناور
  - نقشهٔ زندهٔ تحویل‌ها در Brisbane
  - تامبنیل کالا
  - حلقهٔ شمارش معکوس
  - صفحهٔ جزئیات بازبینی (سند، فیلدهای خوانده‌شده، تایم‌لاین)
- **یک ساختار برای دو پنل:** یک `AppShell`، یک `Sidebar` و یک `Topbar`. تفاوت Admin و Seller فقط در پیکربندی منو، badgeها و مجوزهاست.
- **شش صفحهٔ نمونه** نمونهٔ چهار قالب مشترک‌اند:

| قالب | صفحهٔ Admin | صفحهٔ Seller |
|---|---|---|
| Home (داشبورد) | `F_AdminHome` | `F_SellerHome` |
| Index (فهرست) | `F_AdminSellers` | `F_SellerOrders` |
| Detail (جزئیات و تصمیم) | `F_AdminReview` | — |
| Board (کار لمسی روی تبلت) | — | `F_SellerBoard` |

> همهٔ داده‌های روی بوم نمونه‌اند. اسم‌ها، مبلغ‌ها و ساعت‌ها فقط برای نشان‌دادن چیدمان‌اند.

---

## ۲. چیدمان و شبکه

- **پوسته:**
  - `grid-template-columns: auto minmax(0, 1fr)`
  - منوی کناری `size-sidebar` (248px)، و روی تبلت `size-sidebar-collapsed` (72px)
  - نوار بالا `size-topbar` (64px) و داخل ستون محتوا
- **ناحیهٔ محتوا (main):**
  - padding: `space-7` بالا، `space-8` دو طرف، `space-10` پایین
  - فاصلهٔ بخش‌ها: `space-6` در Home و `space-5` در Index
- **کارت:**
  - زمینه `color-bg-surface`
  - حاشیهٔ ۱px `color-border-default`
  - گوشه `radius-card`
  - padding `space-4-5`
  - عنوان کارت `text-heading-h2` (۱۶/۲۲، وزن ۶۰۰)
- **شبکه‌های رایج:**
  - ردیف شاخص و صف: `repeat(4, minmax(0,1fr))`
  - ستون محتوا و ستون کناری: `minmax(0,1fr) 340–380px`
  - ردیف سه‌ستونه در Home ادمین: `1.5fr 1fr 0.95fr`
- **عرض محتوا:** سیال است و max-width ندارد (مثل A). در عرض ۱۴۴۰ عرض مفید حدود ۱۱۲۸px است.

---

## ۳. توکن‌های اصلی

فهرست کامل: `docs/design/tokens/tokens.css` (۱۵۵ متغیر). تم تاریک با `[data-theme="dark"]` و تراکم لمسی با `[data-density="touch"]` فعال می‌شود. در کد **فقط توکن** به کار برود، نه مقدار خام.

| توکن | مقدار | کاربرد |
|---|---|---|
| `--mp-color-bg-page` | #F5F6F8 | زمینهٔ صفحه |
| `--mp-color-bg-surface` | #FFFFFF | کارت، منو، نوار بالا |
| `--mp-color-bg-subtle` | #F9FAFB | سرستون جدول، پاورقی کارت |
| `--mp-color-bg-selected` | #EDF2FF | آیتم فعال منو، فیلتر اعمال‌شده، دورهٔ انتخاب‌شده |
| `--mp-color-border-default` | #E3E6EB | حاشیهٔ کارت |
| `--mp-color-border-row` | #EEF0F3 | خط بین ردیف‌ها |
| `--mp-color-border-control` | #D0D5DD | دکمهٔ ثانویه |
| `--mp-color-border-input` | #8A93A3 | فیلد ورودی و checkbox (۳.۱:۱ روی سفید، برای WCAG 1.4.11) |
| `--mp-color-text-primary` | #111827 | عنوان و مقدار |
| `--mp-color-text-secondary` | #3F4756 | متن عادی |
| `--mp-color-text-muted` | #5B6475 | متن کمکی (6.0:1 روی سفید) |
| `--mp-color-text-link` | #1B45BD | لینک و تب انتخاب‌شده |
| `--mp-color-action-primary` | #1D4FD7 | دکمهٔ اصلی و سری اصلی نمودار |
| `--mp-color-status-{success,info,attention,critical,neutral}-{bg,fg}` | — | badgeها (همه بالای 6.5:1) |
| `--mp-color-cert-{seller,manufacturer,vegan}-*` | — | تراشهٔ گواهی (CERT-24/44) |
| `--mp-color-chart-compare` | #7C8698 | سری مقایسه، خط‌چین `5 5` |
| `--mp-font-family-sans` | IBM Plex Sans | همهٔ متن‌ها |
| `--mp-font-family-mono` | IBM Plex Mono | شمارهٔ سفارش، شمارهٔ گواهی، `Ctrl K` |
| `--mp-text-body-default` | 400 13.5px/20px | متن پیش‌فرض و جدول |
| `--mp-text-heading-h1` | 600 24px/32px | عنوان صفحه |
| `--mp-text-display-hero` | 600 30px/38px | فقط یک عدد قهرمان در هر صفحه |
| `--mp-radius-card` / `--mp-radius-control` / `--mp-radius-pill` | 12 / 8 / 999px | کارت / کنترل / badge |
| `--mp-size-control` | 36px (لمسی 48px) | ارتفاع دکمه؛ زیر `[data-density="touch"]` خودکار ۴۸ می‌شود |
| `--mp-shadow-elevation-floating` / `--mp-shadow-focus-ring` | — | نوار اقدام گروهی شناور / حلقهٔ فوکوس (در تم تاریک خودکار عوض می‌شود) |

قواعد عددها:

- اعداد ستونی (جدول، محور) `font-variant-numeric: tabular-nums` می‌گیرند.
- عدد قهرمان و مقدار شاخص tabular نمی‌گیرند.

---

## ۴. فهرست کامپوننت‌ها

اسم‌ها پیشنهادی‌اند. API نهایی به D1 (پایهٔ UI) بستگی دارد.

### ۴.۱ پوسته

| کامپوننت | Props اصلی | نکته |
|---|---|---|
| `AppShell` | `workspace: 'admin' \| 'seller'`, `navConfig`, `user`, `market` | یک کامپوننت برای هر دو پنل. منو از پیکربندی و مجوز ساخته می‌شود. |
| `Sidebar` | `items[]`, `active`, `collapsed`, `badges` | هر item: `{id, label, icon, href, permission, badge?, children?}`. گروه‌ها: Commerce/Money/Platform یا Shop/Money. |
| `Topbar` | `crumbs[]`, `searchHint`, `market: {code, currency, tz}`, `notifications`, `user` | جست‌وجو با `Ctrl K` فرمان را باز می‌کند (Command palette بعداً طراحی می‌شود). |
| `ShopSwitcher` | `shops[]`, `current` | فقط در Seller، بالای منو. |

### ۴.۲ نمایش داده

| کامپوننت | Props اصلی | نکته |
|---|---|---|
| `StatTile` | `label`, `value`, `delta?: {text, direction, good}`, `trend?: number[12]`, `meter?: {value, max}` | delta همیشه «نسبت به چه» را می‌گوید (vs last Thu). رنگ delta از ترکیب جهت و خوب‌بودن می‌آید. |
| `KpiStrip` | `tiles[]`, `leading?` (مثلاً دکمهٔ تاریخ) | یک کارت با جداکننده‌های عمودی. |
| `Sparkline` | `values[12]`, `width`, `height`, `tone` | خط ۲px، پر ۱۰٪، نقطهٔ پایانی ۶px با حلقهٔ سفید. محور ندارد. |
| `TrendChart` | `series: {today, compare}`, `cumulative`, `now`, `format` | یک محور y. tooltip و crosshair دارد. legend همیشه هست چون دو سری داریم. نمای جدولی جایگزین هم دارد. |
| `Meter` | `value`, `max`, `tone` یا `thresholds` | ارتفاع ۶px. track از رنگ روشن همان tone است. |
| `DeadlineBadge` | `dueAt`, `startedAt`, `now`, `tz` | متن و tone را خودش حساب می‌کند. نوار زمان مصرف‌شده هم دارد (بخش ۷). |
| `StatusBadge` | `status`, `progress: 0 \| 50 \| 75 \| 100` | دایرهٔ پیشرفت کنار متن تا وضعیت فقط با رنگ گفته نشود. |
| `CertChip` | `kind: 'seller' \| 'manufacturer' \| 'vegan' \| 'self-declared' \| 'revoked'`, `expiresAt?` | خوداظهاری حاشیهٔ خط‌چین دارد. لغوشده خط‌خورده است و «Revoked» کنارش می‌آید. اگر تا انقضا ≤ ۱۴ روز مانده، تاریخ با رنگ attention نشان داده می‌شود. |
| `HealthIndicator` | `state: 'ok' \| 'risk' \| 'bad' \| 'none'` | همیشه آیکن + متن. |
| `ProductThumb` / `ThumbStack` | `category`, `imageUrl?`, `size` / `items[]`, `max=3` | فعلاً گلیف دسته‌بندی است. بعداً عکس واقعی می‌آید (تصمیم صاحب پروژه). بیش از ۳ قلم: `+n`. |
| `IdentityTile` | `initials`, `tone` | لوگوی موقت فروشنده و نوع آیتم صف (CE، RF، PR…). |
| `DonutProgress` | `value`, `label` | مثل ۸۴٪ گواهی‌دار. عدد وسط و توضیح کنارش. |
| `SplitBar` | `parts[]` | مثل پرداخت به فروشنده در برابر کمیسیون. بین بخش‌ها ۲px فاصله. legend و مبلغ زیر آن. |
| `WeeklyBars` | `values[]`, `labels[]`, `highlightLast` | ستون حداکثر ۲۴px، سر گرد ۴px، پایه صاف. فقط آخرین مقدار برچسب عددی دارد. |

### ۴.۳ فهرست و جدول (قالب Index)

| کامپوننت | Props اصلی | نکته |
|---|---|---|
| `SavedViewTabs` | `views[{id,label,count}]`, `active`, `onSave` | زیرخط ۲px آبی. شمارنده با رنگ muted. |
| `FilterBar` | `query`, `filters[]`, `sort`, `columns` | تراشهٔ فیلتر اعمال‌شده با زمینهٔ `bg-selected` و دکمهٔ ×. «Add filter» خط‌چین است. |
| `DataTable` | `columns[]`, `rows[]`, `selection`, `sort`, `pagination`, `rowTone?` | ردیف انتخاب‌شده `bg-row-selected`، ردیف نیازمند اقدام `bg-row-attention`، hover `bg-subtle`. ستون‌های کم‌اهمیت در عرض کمتر از ۱۱۸۰ پنهان می‌شوند. |
| `BulkActionBar` | `count`, `actions[]`, `onClear` | **شناور و sticky** در پایین ناحیهٔ محتوا (`bottom: 20px`). فقط وقتی ≥ ۱ ردیف انتخاب شده ظاهر می‌شود. اقدام خطرناک به رنگ critical است و «…» یعنی تأیید می‌خواهد. |
| `Pagination` | `page`, `pageSize`, `total` | «Rows per page» و دکمه‌های قبلی/بعدی. |

### ۴.۴ جزئیات و تصمیم (قالب Detail)

| کامپوننت | Props اصلی | نکته |
|---|---|---|
| `PageHeader` | `back`, `title`, `badges[]`, `subtitle`, `queueNav: {index,total}` | رفتن به مورد بعدی صف بدون برگشتن به فهرست. |
| `FactsStrip` | `facts[{label,value,tone?}]` | نوار کلید و مقدار زیر عنوان. مهلتِ گذشته قرمز است. |
| `DocumentViewer` | `file`, `pages`, `zoom`, `highlights[]` | برجستگی آبی یعنی «همین الان بررسی کن»، سبز یعنی «تطبیق خورد». فایل قفل است و فقط خواندنی. |
| `ExtractedFields` | `fields[{label,value,match}]` | تگ وضعیت هر فیلد: Matches، Approved registry، Check now، To check. |
| `ChecklistItem` | `title`, `source: 'auto' \| 'manual'`, `doneBy?`, `onConfirm`, `onFlag` | بررسی‌های انسانی دو دکمه دارند: Confirm و Flag a problem. |
| `DecisionPanel` | `impact`, `deadline`, `canApprove`, `onApprove`, `onReject`, `onAsk` | Approve تا همهٔ بررسی‌ها تمام نشده غیرفعال است و دلیلش زیر دکمه نوشته می‌شود. Reject دلیلی می‌خواهد که فروشنده می‌بیند. |
| `Timeline` | `events[]`, `composer` | یادداشت داخلی را فروشنده نمی‌بیند. `@` برای اشاره به هم‌تیمی. |

### ۴.۵ نقشه و Board

| کامپوننت | Props اصلی | نکته |
|---|---|---|
| `DeliveryMap` | `serviceArea`, `sellers[]`, `couriers[]`, `stats` | روی بوم یک SVG سبک‌شده است. نسخهٔ واقعی به تصمیم D13 (ارائه‌دهندهٔ نقشه) بستگی دارد. **نشانی مشتری نشان داده نمی‌شود.** legend سه‌تایی اجباری است. |
| `OrderBoard` | `columns[]` | سه ستون: Needs action، Preparing، Ready for pickup. هر ستون جدا اسکرول می‌شود. |
| `OrderCard` | `order`, `variant: 'normal' \| 'urgent'`, `countdown`, `lines[]`, `actions` | دکمه‌ها ۴۸px. کارت urgent حاشیهٔ قرمز و حلقهٔ ۳px دارد. |
| `CountdownRing` | `minutesLeft`, `windowMinutes`, `tone` | قطر ۴۸px و ضخامت ۴px. عدد و «min» وسط حلقه. |
| `Switch` | `checked`, `label`, `description` | مثل «Taking instant orders until 8:00 pm». با `role="switch"`. |

### ۴.۶ پایه‌ها (Primitives)

`Button` (primary, secondary, destructive-secondary, ghost, link؛ اندازه‌های 32، 36، 44 و 48)، `IconButton`، `SegmentedControl`، `Checkbox`، `Input` و `SearchField`، `Badge`، `Card`، `InfoBanner`، `Tooltip`، `Avatar`.

---

## ۵. کدام صفحه چه کامپوننتی دارد

| صفحه | کامپوننت‌ها |
|---|---|
| `F_AdminHome` | `TrendChart` (فروش امروز و دیروز)، `StatTile`×4 (Orders، Average order، Sellers taking orders با Meter، Dispatched on time)، کارت‌های صف با `DeadlineBadge` و `Meter`، `DataTable` صف بازبینی، `DeliveryMap`، جدول فروشنده‌های برتر با `Sparkline`، `DonutProgress` و فهرست گواهی‌های رو به انقضا، `SplitBar` پرداخت |
| `F_SellerHome` | `InfoBanner` گواهی، کارت‌های مرحلهٔ سفارش با pip، `KpiStrip`، جدول سفارش‌های منتظر با `ThumbStack` و Accept، Preparing now با `Meter`، پیام‌ها، `WeeklyBars` پرداخت، Low stock با `ProductThumb`، پیشرفت تمدید گواهی |
| `F_AdminSellers` | `KpiStrip`، `SavedViewTabs`، `FilterBar`، `DataTable` (لوگو، `StatusBadge`، `CertChip`، `HealthIndicator`، `Sparkline` سفارش‌ها)، `BulkActionBar` |
| `F_SellerOrders` | `KpiStrip` با دکمهٔ تاریخ، `SavedViewTabs`، `FilterBar`، `DataTable` (نوع تحویل، `ThumbStack`، `StatusBadge` با پیشرفت)، `BulkActionBar` (Accept 2 orders) |
| `F_AdminReview` | `PageHeader`، `FactsStrip`، `DocumentViewer`، `ExtractedFields`، `ChecklistItem`×5، `DecisionPanel`، `Timeline`، خلاصهٔ فروشنده |
| `F_SellerBoard` | `OrderBoard`، `OrderCard`، `CountdownRing`، `Switch`، Pause 30 min |

---

## ۶. حالت‌ها و تعامل‌ها

| عنصر | حالت | رفتار |
|---|---|---|
| Button primary | hover / active / disabled / loading | `action-primary-hover` / تیره‌تر / `action-primary-disabled` با متن سفید / spinner و غیرفعال، بدون تغییر عرض |
| Button secondary | hover | زمینه `bg-subtle` |
| همهٔ کنترل‌ها | focus (صفحه‌کلید) | `--mp-shadow-focus-ring` (حلقهٔ آبی با فاصلهٔ هم‌رنگ زمینه). در Figma هر کامپوننت تعاملی حالت Focus دارد. **اجباری است.** |
| ردیف جدول | hover / selected | `bg-subtle` / `bg-row-selected` و checkbox تیک‌خورده |
| Checkbox سرستون | بخشی انتخاب‌شده | حالت indeterminate |
| `BulkActionBar` | ظاهرشدن | با اولین انتخاب از پایین می‌لغزد. با Clear یا Esc بسته می‌شود. |
| `SavedViewTabs` | تغییر تب | فیلترها عوض می‌شوند و انتخاب ردیف‌ها پاک می‌شود. شمارنده‌ها زنده‌اند. |
| تراشهٔ فیلتر | × | فیلتر حذف می‌شود و نتیجه بی‌درنگ به‌روز می‌شود. Clear all وقتی ≥ ۲ فیلتر داریم. |
| `TrendChart` | hover / لمس | crosshair عمودی و tooltip تیره با ساعت و مبلغ هر دو سری. بدون hover، آخرین نقطه برچسب دارد. |
| `DeliveryMap` | hover روی پین | tooltip با نام فروشنده و تعداد سفارش باز. پیک‌ها هر ۳۰ ثانیه به‌روز می‌شوند. |
| `OrderCard` Accept | کلیک | کارت به Preparing می‌رود (optimistic). اگر سرور رد کند، کارت برمی‌گردد و پیام خطا نشان داده می‌شود. |
| Item unavailable | کلیک | پنجرهٔ انتخاب قلم و جایگزین. قاعدهٔ کسب‌وکارش هنوز باز است (G1 سفارش). |
| `Switch` سفارش فوری | خاموش | تأیید می‌خواهد: «New instant orders stop now. Scheduled orders are not affected.» |
| `DecisionPanel` Approve | غیرفعال | tooltip و متن زیر دکمه دلیل را می‌گویند: «Complete the 2 remaining checks». |

---

## ۷. قواعد مهلت، شمارش معکوس و آستانه‌ها

> این‌ها پیشنهاد طراحی‌اند و **تأیید هادی (PO) لازم دارند** (D15). مقدار SLA هر نوع آیتم از سرور می‌آید و در فرانت ثابت نوشته نمی‌شود.

| قاعده | پیشنهاد |
|---|---|
| رنگ نوار زمان مصرف‌شده | کمتر از ۷۵٪: accent (آبی). ۷۵ تا ۹۹٪: attention. ۱۰۰٪ و بیشتر: critical (نوار پر). |
| متن `DeadlineBadge` | گذشته: «Overdue 4 h». همان روز: «Due 5:00 pm». فردا: «Due tomorrow 8:50 am». بعدتر: «Due 2 Oct». |
| tone `DeadlineBadge` | گذشته critical. کمتر از ۲۴ ساعت attention. بیشتر neutral. |
| حلقهٔ Board: Needs action | اگر انتظار ≥ ۸ دقیقه: critical و کارت urgent. وگرنه attention. |
| حلقهٔ Board: Preparing | اگر ≤ ۲۰ دقیقه تا ready-by مانده: attention. وگرنه accent. |
| حلقهٔ Board: Ready | success. شمارش تا رسیدن پیک. |
| به‌روزرسانی شمارش‌ها | هر ۶۰ ثانیه، نه هر ثانیه، تا حواس‌پرتی و نویز صفحه‌خوان کم شود. |
| منطقهٔ زمانی | همیشه منطقهٔ زمانی بازار (AEST، Brisbane بدون تغییر ساعت تابستانی). در نوار بالا دیده می‌شود. |

---

## ۸. رفتار واکنش‌گرا

| عرض | تغییرها |
|---|---|
| ≥ ۱۱۸۰px | چیدمان کامل مثل بوم. |
| ۷۶۰ تا ۱۱۷۹px | ردیف‌های ۴تایی دوستونی می‌شوند. ستون کناری زیر ستون اصلی می‌آید. ستون‌های `.wide` جدول پنهان می‌شوند (سفارش ۳۰ روز، لغو، تاریخ عضویت؛ اقلام، پرداخت). |
| < ۷۶۰px | منوی کناری پنهان می‌شود. **کشوی منوی موبایل هنوز طراحی نشده** (D16). |
| تبلت افقی ۱۱۸۰×۸۲۰ (Board) | منوی جمع‌شده ۷۲px، دکمه‌ها ۴۸px، متن ۱۴ تا ۱۵px، و هر ستون جدا اسکرول می‌شود. حالت عمودی هنوز طراحی نشده. |

دلیل: فروشنده روی تبلت کنار پیشخوان و با دست شلوغ کار می‌کند، برای همین هدف‌های لمسی بزرگ‌اند و Board ساده است. ادمین روی دسکتاپ کار می‌کند و تراکم اطلاعات اولویت دارد.

---

## ۹. حالت‌های مرزی

| مورد | رفتار |
|---|---|
| صف خالی | «Nothing waiting. You're up to date.» با آیکن تیک. شمارنده‌ها صفر می‌شوند و کارت حذف نمی‌شود. |
| نمودار بدون فروش | خط صاف روی صفر و متن «No sales yet today». سری مقایسه همچنان دیده می‌شود. |
| بارگذاری | skeleton هم‌اندازهٔ کارت‌ها و ۸ ردیف جدول. برای بارگذاری صفحه spinner نمی‌گذاریم. |
| خطای بارگذاری یک کارت | پیام درون همان کارت با «Try again». بقیهٔ صفحه کار می‌کند. |
| دادهٔ زنده قطع شد | badge «Live» به «Reconnecting…» تغییر می‌کند و زمان آخرین به‌روزرسانی نشان داده می‌شود. |
| نام طولانی | یک خط با ellipsis و `title`. نام فروشنده و قلم کالا شکسته نمی‌شوند. |
| بیش از ۳ قلم | `ThumbStack` سه تامبنیل و `+n` نشان می‌دهد. |
| بدون گواهی | «None yet» با رنگ muted. |
| مبلغ صفر یا نامعتبر | «—» با رنگ muted، نه «AUD 0.00». مگر وقتی صفر واقعی است، مثل فروشندهٔ معلق. |
| متن بلندتر در زبان‌های بعدی و RTL | چیدمان با ویژگی‌های منطقی (`inline-start/end`) ساخته شود. چند padding فیزیکی که در پیش‌نمایش مانده، در کد منطقی شوند. |

---

## ۱۰. حرکت (Motion)

| عنصر | محرک | انیمیشن | مدت | easing |
|---|---|---|---|---|
| `BulkActionBar` | انتخاب اولین ردیف | لغزش ۸px و fade | `motion-base` (160ms) | `motion-easing` |
| `OrderCard` | Accept یا Mark ready | جابه‌جایی به ستون بعد | `motion-slow` (240ms) | `motion-easing` |
| hover کنترل‌ها | hover | تغییر رنگ | `motion-fast` (120ms) | linear |
| سفارش تازه در Board | رسیدن سفارش | یک بار درخشش حاشیه، صدای کوتاه | 1200ms | ease-out |

با `prefers-reduced-motion` همهٔ جابه‌جایی‌ها بی‌درنگ انجام می‌شوند.

---

## ۱۱. دسترس‌پذیری (WCAG 2.2 AA)

**ترتیب فوکوس:**

1. پرش به محتوا (skip link)
2. منوی کناری
3. نوار بالا (جست‌وجو، بازار، اعلان‌ها، کاربر)
4. محتوا، از سرصفحه به ترتیب خواندن
5. نوار اقدام گروهی، آخر از همه

**نقش‌ها و برچسب‌ها:**

- جدول‌ها: `role="table"` با `aria-sort` و `aria-rowcount`. checkbox هر ردیف برچسب «Select <نام>» دارد.
- نوار زمان: `role="meter"` با `aria-valuenow`.
- حلقهٔ شمارش: `role="timer"` با `aria-live="off"`. فقط عبور از آستانه اعلام می‌شود.
- نمودار و نقشه: `role="img"` با `aria-label` خلاصه، و دکمهٔ «View as table» برای دادهٔ کامل.
- کلید سفارش فوری: `role="switch"`.
- نوار اقدام گروهی: `role="toolbar"`. با ظاهرشدن اعلام می‌شود: «2 selected».
- سفارش تازه: `aria-live="polite"` و صدای قابل خاموش‌کردن.

**رنگ:**

- هیچ وضعیتی فقط با رنگ گفته نمی‌شود. badge آیکن یا دایرهٔ پیشرفت دارد، و سلامت آیکن و متن.
- کنتراست‌ها بررسی شده‌اند:
  - متن‌ها ≥ 4.5:1
  - مرز فیلدها و checkbox 3.1:1
  - سری مقایسهٔ نمودار 3.7:1
- رنگ `#8A93A3` (`border-input`) فقط برای مرز است، نه متن.

**صفحه‌کلید:**

- `Ctrl K` جست‌وجو را باز می‌کند.
- در صف بازبینی، `J` و `K` به مورد بعد و قبل می‌روند (پیشنهاد از جهت B، هنوز تأیید نشده).
- Space روی ردیف آن را انتخاب می‌کند.
- Esc انتخاب را پاک می‌کند و پنجره را می‌بندد.

**هدف لمسی:** روی تبلت ۴۴ تا ۴۸px است. روی دسکتاپ کمتر از ۳۲px نمی‌شود (WCAG 2.5.8 حداقل ۲۴px را می‌خواهد).

---

## ۱۲. قالب‌بندی داده

| داده | قالب | نمونه |
|---|---|---|
| مبلغ | کد ارز + فاصله + عدد با جداکنندهٔ هزار و دو رقم اعشار | AUD 2,146.90 |
| مبلغ در ستون‌های هم‌ارز | بدون کد ارز وقتی سرستون ارز را گفته | 18,420.35 |
| GST | «incl. GST» کنار جمع، یا ردیف جدا در جزئیات | AUD 142.75 · Includes GST AUD 2.45 |
| زمان | ۱۲ساعته با am/pm کوچک | 2:30 pm |
| تاریخ | روز ماه سال، بدون صفر اول | 1 Oct 2026 |
| مدت | کوتاه و انسانی | 9 min · 2 days 4 h |
| شمارهٔ سفارش | Mono | MP-10482 |
| تغییر نسبت به گذشته | فلش + مقدار + «vs» + دورهٔ نام‌دار | ↑ 11% vs last Thu |

همهٔ رشته‌ها از i18n بیایند (en-AU در شروع)، حتی اگر فعلاً فقط انگلیسی داریم.

---

## ۱۳. دادهٔ لازم برای هر کامپوننت (پیش‌نویس قرارداد)

> قرارداد نهایی API در G1 هر ماژول با حسین (Backend) و محمد (Architect) بسته می‌شود.

```ts
type Money = { amount: string; currency: 'AUD' };                 // مبلغ رشته‌ای برای دقت اعشار
type StatTileData = { value: number | Money; previous?: number | Money; trend?: number[]; target?: number };
type TrendSeries = { points: { at: string; value: Money }[]; compare?: { at: string; value: Money }[] };
type ReviewItem = { id: string; kind: 'certification' | 'refund' | 'product_revision' | 'seller_application' | 'category_proposal';
  title: string; sellerId: string; sellerName: string; createdAt: string; dueAt: string };
type SellerRow = { id: string; name: string; handle: string; suburb: string; status: 'active' | 'awaiting_approval' | 'suspended';
  certs: { kind: 'seller' | 'manufacturer' | 'vegan' | 'self_declared'; scheme: string; expiresAt?: string; revoked?: boolean }[];
  health: 'ok' | 'risk' | 'bad' | 'none'; orders30d: number; ordersTrend: number[]; cancelRate?: number; joinedAt: string };
type OrderRow = { id: string; placedAt: string; mode: 'instant' | 'next_day'; readyBy?: string; window?: { from: string; to: string };
  items: { category: string; name: string; qty: string; imageUrl?: string }[]; total: Money;
  status: 'needs_action' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'scheduled'; payout?: string };
type LiveDeliveries = { inTransit: number; avgMinutes: number; lateNow: number;
  sellers: { id: string; lat: number; lng: number; openOrders: number }[]; couriers: { id: string; lat: number; lng: number }[] };
```

---

## ۱۴. ترتیب پیشنهادی ساخت

| مرحله | خروجی | وابستگی |
|---|---|---|
| F0 | توکن‌ها در کد (`tokens.css`، نگاشت به Tailwind در صورت انتخاب)، فونت‌ها، `AppShell`، `Sidebar` با پیکربندی منو و مجوز، `Topbar` | D1 و D2 |
| F1 | پایه‌ها: Button، Badge، Card، Checkbox، Input، Switch، Tabs، SegmentedControl، Tooltip | F0 |
| F2 | نمایش داده: `StatTile`، `Sparkline`، `Meter`، `DeadlineBadge`، `StatusBadge`، `CertChip`، `HealthIndicator`، `ProductThumb` | F1 |
| F3 | قالب Index: `DataTable`، `FilterBar`، `SavedViewTabs`، `BulkActionBar`، `Pagination` | F2 |
| F4 | نمودار: `TrendChart`، `DonutProgress`، `SplitBar`، `WeeklyBars`، `CountdownRing` | D14 |
| F5 | قالب Detail: `DocumentViewer`، `ExtractedFields`، `ChecklistItem`، `DecisionPanel`، `Timeline` | F3 |
| F6 | `DeliveryMap` | D13 |

- برای هر کامپوننت، یک صفحهٔ نمونه با همهٔ حالت‌ها پیشنهاد می‌شود: default، hover، focus، disabled، loading، empty و error.
  - ابزارش (مثلاً Storybook) را مهدی پیشنهاد می‌دهد.
- سجاد (QA) با همین فهرست حالت‌ها تست می‌نویسد.

---

## ۱۵. تصمیم‌های باز و شکاف‌ها

| شناسه | موضوع | پیشنهاد |
|---|---|---|
| D1 | پایهٔ UI | shadcn/ui روی Radix یا Base UI، Tailwind v4، TanStack Table. نیازمند spike و ADR. |
| D2 | توپولوژی اپ | `packages/ui` مشترک، پیکربندی منو، و دو اپ نازک. نیازمند ADR. |
| D5 | حالت تاریک | توکن‌ها و پیش‌نمایش تاریک در Figma آماده است (`color.dark.json`، `[data-theme="dark"]`). زمان فعال‌کردن در محصول تصمیم محصول است. |
| D13 | ارائه‌دهندهٔ نقشه | بین MapLibre، Mapbox و Google: هزینه، حریم خصوصی، کاشی‌های استرالیا. |
| D14 | کتابخانهٔ نمودار | SVG سفارشی سبک یا کتابخانه‌ای مثل visx یا Recharts. شرط: یک محور، tooltip و نمای جدولی. |
| D15 | آستانه‌های مهلت و شمارش معکوس | جدول بخش ۷. تأیید هادی. |
| D16 | منوی موبایل (< ۷۶۰px) و Board عمودی | طراحی نشده. |
| — | حالت focus | حل شد: در کتابخانهٔ Figma رسم شده و توکنش `--mp-shadow-focus-ring` است. |
| — | Item unavailable | قاعدهٔ کسب‌وکار در G1 سفارش. |
| — | Command palette (`Ctrl K`) | فقط نقطهٔ ورود طراحی شده. |

---

## ۱۶. نکته‌هایی از ساخت پیش‌نمایش

- پیش‌نمایش در قالب `.dc.html` ساخته شده و کد تولیدی نیست. مقدارها را از توکن‌ها بخوانید، نه از استایل‌های درون‌خطی بوم.
- در بوم، جدول‌ها با `div` و `role="table"` ساخته شده‌اند (محدودیت قالب بوم). در React می‌شود `<table>` واقعی یا TanStack Table به کار برد. نقش‌ها و `aria-*` همان می‌مانند.
- تامبنیل‌ها گلیف موقت‌اند و API باید `imageUrl` را از اول داشته باشد.
- همهٔ داده‌ها نمونه‌اند. شمارنده‌های منو (۳۵، ۶، ۳، ۲) از سرور می‌آیند.
