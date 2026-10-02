# سیستم طراحی MondaPac در Figma: راهنما و قواعد نگهداری

| | |
|---|---|
| نسخه | 1.0.0 (۲ اکتبر ۲۰۲۶) |
| فایل Figma | **MondaPac Design System** (Drafts تیم mondapac، پلن Starter) |
| مالک کتابخانه | رضا (UI/UX) |
| هم‌خوان‌ها | جعفر (Product Designer)، مهدی (Frontend)، سجاد (QA)، هادی (Product Owner) |
| تصمیم | ADR-0017: از این پس هر تغییر UI/UX پنل‌ها اول در Figma انجام می‌شود |
| ابزار | افزونهٔ توسعهٔ `docs/design/figma/plugin` (ساخت، تم، تراکم، Export، Audit، ارتقا) |

---

## ۱. منبع حقیقت و مسیر تغییر

```
Figma (متغیرها، استایل‌ها، کامپوننت‌ها)
   │  افزونه → Export tokens
   ▼
docs/design/tokens/*.json + tokens.css   ← در گیت کامیت می‌شود
   │
   ▼
packages/ui (کد React)                   ← فقط از توکن‌ها می‌خواند
```

- **Figma منبع حقیقت ظاهر است.** کد از توکن‌های صادرشده پیروی می‌کند، نه برعکس.
- هیچ مقدار خام (hex، px) نه در Figma و نه در کد نوشته نمی‌شود. همه‌چیز متغیر است.
- بوم «MondaPac Panel Shell» از این به بعد فقط پیش‌نمایش تاریخی است و به‌روز نمی‌شود.
- `tokens_spec.py` فقط «بذر» نسخهٔ 1.0.0 بود. بعد از ساخت، تغییر توکن‌ها در Figma انجام می‌شود.

---

## ۲. ساختار فایل

پلن Starter هر فایل را به **۳ صفحه** محدود می‌کند. افزونه همین ساختار را می‌سازد و هر موضوع را یک **Section** روی بوم می‌گذارد. بعد از ارتقای پلن، دستور «Upgrade to modes» هر Section را به صفحهٔ خودش می‌برد.

| صفحه (Starter) | Sectionها | صفحه‌ها بعد از ارتقا |
|---|---|---|
| 1 · Start & foundations | Cover، Getting started، Changelog، Colour، Typography، Spacing size & radius، Elevation & motion، Icons، Accessibility | هر کدام یک صفحه، زیر جداکنندهٔ «Foundations» |
| 2 · Components | Actions، Forms & selection، Status & feedback، Data display، Tables & collections، Navigation & shell، Review & detail، Board & delivery | هر کدام یک صفحه، زیر «Components» |
| 3 · Templates & workspace | Templates · Admin، Templates · Seller، Templates · Dark preview، Sandbox، Archive | زیر «Templates» و «Workspace» |

- **Sandbox:** پیشنهادهای در حال کار. چیزی که اینجاست جزو کتابخانه نیست.
- **Archive:** کامپوننت‌های کنارگذاشته، تا وقتی که دیگر جایی استفاده نشوند.

---

## ۳. معماری متغیرها

| Collection | تعداد | حالت‌ها (Modes) | محتوا |
|---|---|---|---|
| Primitives | ۱۳۷ | Value | رنگ‌های خام. از Library پنهان‌اند و scope ندارند، پس طراح مستقیم انتخابشان نمی‌کند. |
| Color | ۸۹ | Light (+ Dark بعد از ارتقا) | توکن‌های معنایی که به Primitives اشاره می‌کنند (alias). |
| Color · Dark | ۸۹ | Dark | فقط روی Starter. همان نام‌ها با مقدار تاریک. |
| Dimension | ۳۰ | Desktop (+ Touch بعد از ارتقا) | فاصله، گوشه، اندازهٔ کنترل، عرض منو، ضخامت مرز. |
| Dimension · Touch | ۳۰ | Touch | فقط روی Starter. اندازه‌های لمسی تبلت. |
| Typography | ۴۶ | Value | خانوادهٔ فونت، اندازه و ارتفاع خط هر سبک متن. داخل Text styleها bind شده‌اند. |
| Motion | ۳ | Value | مدت حرکت: 120، 160 و 240 میلی‌ثانیه. |

**قواعد:**

- نام Primitive یعنی خانوادهٔ رنگ و درجهٔ تیرگی: `color/blue/560`. درجه = ۱۰۰۰ × (۱ − روشنایی OKLab). عدد بزرگ‌تر یعنی تیره‌تر.
- نام توکن معنایی نقش را می‌گوید، نه رنگ را: `bg/surface`، `text/muted`، `status/critical/fg`.
- **Scope** هر متغیر محدود است. مثلاً `text/*` در انتخاب‌گر fill متن و آیکن می‌آید و `border/*` در stroke و خط جداکننده. تست افزونه بررسی می‌کند که scopeها همهٔ کاربردها را پوشش بدهند.
- روی همهٔ متغیرها **Code syntax** از نوع WEB تنظیم شده است، مثل `var(--mp-color-text-muted)`. پس اسم Figma و اسم کد یکی است.
- رنگ‌های حلقهٔ فوکوس و حلقهٔ کارت فوری داخل Effect style به متغیر وصل‌اند، پس با تم عوض می‌شوند.

---

## ۴. سبک‌ها

- **۲۲ Text style** در گروه‌های Display، Heading، Body، Caption، Label، Touch و Mono. فونت IBM Plex Sans برای رابط و IBM Plex Mono برای شمارهٔ سفارش و گواهی.
- **۴ Effect style:** `Elevation/Floating` (نوار اقدام گروهی)، `Elevation/Document` (سند)، `Focus/Ring` (حلقهٔ فوکوس)، `Ring/Urgent` (کارت سفارش فوری).
- طراحی تخت است. مرز سطح‌ها را از هم جدا می‌کند و سایه فقط برای چیزهای شناور است.

---

## ۵. کامپوننت‌ها

**۴۱ کامپوننت** (۳۰ مجموعهٔ variant با ۲۳۵ variant، و ۱۱ کامپوننت تکی) و **۵۸ آیکن**:

| صفحه | کامپوننت‌ها |
|---|---|
| Actions | Button، IconButton |
| Forms & selection | Input، Checkbox، Switch، SegmentedControl، Tab، FilterChip |
| Status & feedback | Badge، StatusBadge، CountBadge، CertChip، HealthIndicator، Meter، DeadlineBadge، InfoBanner، Tooltip |
| Data display | IdentityTile، ProductThumb، Sparkline، StatTile، TrendChart، DonutProgress، SplitBar، WeeklyBars، CountdownRing |
| Tables & collections | TableCell، CardHeader، Pagination، BulkActionBar |
| Navigation & shell | NavItem، NavSubItem، NavGroupLabel، Sidebar، Topbar |
| Review & detail | QueueCard، ExtractedField، ChecklistItem، TimelineItem |
| Board & delivery | OrderCard، DeliveryMap |

**قواعد ساخت هر کامپوننت:**

1. **فقط با Auto layout.** چیدمان با start/end ساخته می‌شود تا برای RTL قرینه شود.
2. **همهٔ حالت‌ها:** Default، Hover، Focus، Disabled و در صورت نیاز Error، Selected و Loading. حالت Focus همیشه `Focus/Ring` دارد.
3. **Propertyها به جای detach:**
   - متن قابل تغییر: TEXT (مثل `Label`)
   - نمایش و پنهان: BOOLEAN (مثل `Leading icon`، `Show count`)
   - آیکن: INSTANCE_SWAP به نام `Icon`
   - instanceهای تودرتو که باید از بیرون تنظیم شوند، expose می‌شوند (مثل شمارندهٔ NavItem).
4. **متنی که بین variantها فرق دارد** به TEXT property وصل نمی‌شود، چون property یک متن را روی همهٔ variantها می‌نشاند. نمونه: وضعیت OrderCard.
5. **Variantها در شبکه چیده می‌شوند:** ستون‌ها مقدارهای آخرین محور (معمولاً State) و ردیف‌ها ترکیب بقیهٔ محورها.
6. **هر کامپوننت توضیح دارد** (Description) و کنارش پنل Usage: کِی استفاده شود، propertyها، دسترس‌پذیری و موارد پرهیز.
7. **چگالی لمسی:** کامپوننت‌های تبلت (OrderCard، Button Touch، IconButton Touch) Touch density دارند: دکمهٔ ۴۸ پیکسلی و متن ۱۴ تا ۱۵ پیکسلی.

---

## ۶. قالب‌ها و تم تاریک

- **قالب‌ها** فقط از instanceهای کتابخانه ساخته شده‌اند: Admin (Home، Sellers، Certificate review) و Seller (Home، Orders، Order board تبلت).
- برای صفحهٔ جدید، یک قالب را کپی کنید. **پوسته (Sidebar و Topbar) را detach نکنید.** آیتم فعال منو را با property `State` روی NavItem تودرتو عوض کنید.
- **Dark preview** سه قالب را در تم تاریک نشان می‌دهد.
- **تعویض تم یا تراکم یک فریم:**
  - روی Starter: فریم را انتخاب کنید و در افزونه «Dark theme / Light theme» یا «Touch density / Desktop density» را بزنید. افزونه متغیرها را به collection دیگر وصل می‌کند.
  - بعد از ارتقا: از پنل Appearance فیگما، mode را عوض کنید.

---

## ۷. نام‌گذاری

| چیز | الگو | نمونه |
|---|---|---|
| متغیر رنگ | نقش/نام یا نقش/حالت/بخش | `bg/surface` · `status/critical/fg` |
| متغیر ابعاد | دسته/پله | `space/4` · `radius/card` · `size/control` |
| متغیر در کد | `--mp-` + مسیر با خط تیره | `--mp-color-text-muted` · `--mp-space-4` |
| Text style | گروه/نام | `Body/Default` · `Heading/H1` |
| کامپوننت | PascalCase، هم‌نام کامپوننت React | `StatusBadge` · `OrderCard` |
| Variant | کلید و مقدار با حرف اول بزرگ | `Variant=Primary, Size=Md, State=Hover` |
| لایهٔ داخل کامپوننت | kebab-case | `label` · `icon-leading` · `meter-fill` |
| پیشنهاد در Sandbox | `Proposal · <component> · <ticket>` | `Proposal · DateRangePicker · UI-142` |

---

## ۸. گردش کار تغییر

| گام | چه کسی | کار |
|---|---|---|
| ۱. پیشنهاد | طراح | در Sandbox، با توکن‌ها و کامپوننت‌های موجود. تیکت لینک شود. |
| ۲. بازبینی | رضا + جعفر (+ سجاد برای دسترس‌پذیری) | فهرست «آمادهٔ انتشار» پایین همین بخش |
| ۳. انتشار | رضا | انتقال به صفحهٔ کتابخانه، بالا بردن نسخه، ردیف تازه در Changelog |
| ۴. صدور توکن | رضا | افزونه → Export tokens → ذخیره در `docs/design/tokens/` → کامیت و PR |
| ۵. ساخت | مهدی | به‌روزرسانی `packages/ui` |
| ۶. کنترل | سجاد | تطبیق صفحه‌ها با Figma و تست حالت‌ها |

**فهرست «آمادهٔ انتشار»:**

- [ ] فقط متغیر، Text style و Effect style. هیچ رنگ یا اندازهٔ خام.
- [ ] همهٔ حالت‌ها، از جمله Focus و Disabled.
- [ ] در هر دو تم بررسی شده (افزونه → Dark theme).
- [ ] اگر برای Seller روی تبلت است، در Touch density هم بررسی شده.
- [ ] کنتراست: متن ≥ 4.5:1، مرز کنترل و گرافیک ≥ 3:1. وضعیت فقط با رنگ گفته نمی‌شود.
- [ ] Description و پنل Usage نوشته شده.
- [ ] **افزونه → Audit file** هیچ هشداری ندارد: رنگ بدون متغیر، متن بدون استایل، لایهٔ بیرون‌زده، کامپوننت بدون توضیح، Focus بدون حلقه.

---

## ۹. نسخه‌بندی

- **SemVer:**
  - MAJOR: تغییر نام یا حذف (توکن، کامپوننت، property).
  - MINOR: کامپوننت، variant یا توکن تازه.
  - PATCH: اصلاح مقدار یا ظاهر بدون تغییر API.
- نسخه در افزونه (فیلد Version هنگام Export) و صفحهٔ Changelog ثبت می‌شود.
- **کنار گذاشتن:** نام کامپوننت `Deprecated / <Name>` می‌شود. در توضیح می‌نویسیم «Use <Replacement> instead (since vX.Y)» و به Archive منتقل می‌شود. حذف واقعی فقط در نسخهٔ MAJOR بعدی است.

---

## ۱۰. همگام‌سازی با کد

- **فایل‌های `docs/design/tokens/`:**
  - `primitives.json`: رنگ‌های خام
  - `color.light.json` و `color.dark.json`: توکن‌های معنایی که به primitives اشاره دارند
  - `dimension.desktop.json` و `dimension.touch.json`
  - `typography.json`
  - `tokens.css`
- همهٔ JSONها قالب W3C DTCG دارند و با Style Dictionary یا هر ابزار DTCG خوانده می‌شوند.
- **`tokens.css`:**
  - پیش‌فرض روشن و دسکتاپ است.
  - `[data-theme="dark"]` تم تاریک را فعال می‌کند.
  - `[data-density="touch"]` اندازه‌های تبلت را فعال می‌کند.
  - تایپوگرافی با `font` کوتاه‌نویسی شده است: `font: var(--mp-text-body-default)`، و فاصلهٔ حروف با `letter-spacing: var(--mp-text-heading-h1-tracking)`.
- **خروجی Export با فایل‌های ریپو بایت‌به‌بایت یکی است.** اگر بعد از Export در گیت diff دیدید، یعنی واقعاً در Figma چیزی عوض شده است.
- پیشنهاد برای CI: اجرای `node docs/design/figma/plugin/test/run.js` در هر PR که افزونه یا توکن‌ها را عوض می‌کند.

---

## ۱۱. محدودیت‌های پلن Starter و مسیر ارتقا

| محدودیت Starter | راه حل فعلی | بعد از ارتقا به Professional |
|---|---|---|
| ۳ صفحه در هر فایل | هر موضوع یک Section | Upgrade to modes → ۲۶ صفحه |
| ۱ mode در هر collection | collectionهای موازی `Color · Dark` و `Dimension · Touch` | Upgrade to modes → Light/Dark و Desktop/Touch در یک collection. همهٔ لایه‌ها دوباره وصل می‌شوند و collectionهای موازی حذف می‌شوند. |
| انتشار Team library ممکن نیست | صفحه‌های محصول در همین فایل ساخته می‌شوند | این فایل به‌عنوان Library منتشر می‌شود و فایل‌های محصول از آن استفاده می‌کنند |
| Dev Mode نیست | Code syntax روی متغیرها تنظیم شده و توکن‌ها در ریپو هستند | Dev Mode اسم CSS هر مقدار را نشان می‌دهد |
| ۳ فایل طراحی در تیم | یک فایل برای سیستم طراحی | — |

**مراحل ارتقا:** پلن را ارتقا دهید ← فایل را باز کنید ← افزونه → **Upgrade to modes** ← **Audit file** ← **Export tokens** (باید بدون diff باشد) ← انتشار Library.

---

## ۱۲. افزونه

**نصب، یک بار روی هر کامپیوتر:**

Figma Desktop ← Plugins ← Development ← Import plugin from manifest ← `docs/design/figma/plugin/manifest.json`

| دکمه | کار |
|---|---|
| Build library | ساخت کامل در فایل خالی. «Rebuild» هر چه افزونه ساخته پاک می‌کند و از نو می‌سازد. **روی کتابخانه‌ای که دستی ویرایش شده اجرا نشود.** |
| Dark theme / Light theme | تعویض تم فریم‌های انتخاب‌شده |
| Touch density / Desktop density | تعویض تراکم فریم‌های انتخاب‌شده |
| Export tokens | ۷ فایل توکن از متغیرها و استایل‌های Figma |
| Audit file | lint کل فایل. روی نسخهٔ فعلی: ۱۱٬۷۲۸ لایه و صفر هشدار |
| Upgrade to modes | بعد از ارتقای پلن |

توسعهٔ خود افزونه: [`plugin/README.md`](plugin/README.md). هر تغییر در افزونه باید `node test/run.js` را بدون خطا بگذراند. این تست با شبیه‌ساز سخت‌گیر API فیگما چهار سناریو را اجرا می‌کند و برابری Export با ریپو را می‌سنجد.

---

## ۱۳. نقش‌ها

| کار | مسئول | تأیید | مطلع |
|---|---|---|---|
| تغییر توکن یا کامپوننت | رضا | جعفر | مهدی، سجاد |
| کامپوننت تازه برای یک ماژول | رضا و جعفر (بعد از G1 همان ماژول) | هادی | مهدی |
| Export و کامیت توکن‌ها | رضا | مهدی (بازبینی PR) | سجاد |
| پیاده‌سازی در کد | مهدی | محمد (معماری) | رضا |
| بررسی دسترس‌پذیری | سجاد | رضا | هادی |

---

## ۱۴. موارد باز

- **D5 حالت تاریک در محصول:** توکن‌ها و پیش‌نمایش آماده‌اند. زمان فعال‌کردنش تصمیم محصول است.
- **D16 منوی موبایل و Board عمودی:** هنوز کامپوننت ندارند.
- **حالت‌های Loading و Empty:** برای TableCell، StatTile و کارت‌ها در مرحلهٔ طراحی ماژول‌ها اضافه می‌شوند.
- **عکس واقعی کالا:** جای ProductThumb را می‌گیرد، با همان اندازه و گوشه.
- **نسخهٔ RTL:** چیدمان آماده است. آزمون کامل با متن فارسی یا عربی، وقتی زبان دوم برنامه‌ریزی شد.

---

## ۱۵. به‌روزرسانی در فاز تولید (قاعدهٔ دائمی)

تصمیم صاحب پروژه (۲ اکتبر ۲۰۲۶): با شروع تولید، هر صفحه یا امکان تازه **اول** در سیستم طراحی Figma اضافه می‌شود. بعد توکن‌ها صادر می‌شوند و فرانت آن را می‌سازد. سیستم طراحی هیچ‌وقت نباید از محصول عقب بماند.

| رویداد | کار روی سیستم طراحی | مسئول |
|---|---|---|
| G2 ماژول دارای رابط کاربری | بخش ۱۲ برگهٔ ماژول (فهرست اثر)، طراحی در Sandbox، قالب‌های تازه، انتشار و Export | رضا، جعفر |
| برش فرانت که چیزی در کتابخانه ندارد | پیش از کدنویسی: variant، حالت، کامپوننت یا توکن در Figma، سپس Export | رضا → مهدی |
| بازخورد تولید | اصلاح توکن یا کامپوننت با نسخهٔ PATCH یا MINOR | رضا |
| بعد از هر انتشار | مقایسهٔ صفحه‌های کد با قالب‌های Figma و رفع اختلاف | سجاد، رضا |

**قاعدهٔ انتخاب:**

- اول از چیزهای موجود استفاده کنید.
- کامپوننت تازه فقط وقتی ساخته می‌شود که عنصر در دست‌کم دو جا یا هر دو پنل تکرار شود.
- عنصر یک‌باره در خود قالب ساخته می‌شود، از کامپوننت‌های موجود.

روال کامل: [`update-procedure.md`](update-procedure.md). skill اکانت `mondapac-design-system-update` همین فایل را بارگذاری می‌کند. این قاعده در CLAUDE.md (قاعدهٔ ۱۲ و Definition of Done) و در ADR-0017 (بند ۶) هم ثبت شده است.
