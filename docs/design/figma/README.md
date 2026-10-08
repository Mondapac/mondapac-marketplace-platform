# سیستم طراحی MondaPac در Figma: راهنما و قواعد نگهداری

| | |
|---|---|
| نسخه | 1.9.0 «Seller setup» (۸ اکتبر ۲۰۲۶). نسخه‌های 1.8.4 «Fixes from the 1.8.3 run» و 1.8.3 «Panel follow-up» همان روز بودند. نسخه‌های 1.8.2 «Layout fixes»، 1.8.1 «Audit fixes for the Panel pages» و 1.8.0 «Panel» در ۷ اکتبر ۲۰۲۶ بودند. نسخهٔ 1.7.0 «Auth» همان روز بود. نسخه‌های 1.6.0 «Mobile navigation polish» و 1.5.0 «Mobile navigation» همان روز بودند و نسخهٔ 1.0.0 در ۲ اکتبر ۲۰۲۶ ساخته شد. |
| فایل Figma | **MondaPac Design System** (Drafts تیم mondapac، پلن Starter) |
| مالک کتابخانه | رضا (UI/UX) |
| هم‌خوان‌ها | جعفر (Product Designer)، مهدی (Frontend)، سجاد (QA)، هادی (Product Owner) |
| تصمیم | ADR-0017: از این پس هر تغییر UI/UX پنل‌ها اول در Figma انجام می‌شود |
| ابزار | افزونهٔ توسعهٔ `docs/design/figma/plugin` (ساخت، به‌روزرسانی کتابخانه، تم، تراکم، Export، Audit، ارتقا) |

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
| 3 · Templates & workspace | Templates · Admin، Templates · Seller، Templates · Auth (از 1.7.0)، Templates · Dark preview، Sandbox، Archive | زیر «Templates» و «Workspace» |

- **Sandbox:** پیشنهادهای در حال کار. چیزی که اینجاست جزو کتابخانه نیست.
- **Archive:** کامپوننت‌های کنارگذاشته، تا وقتی که دیگر جایی استفاده نشوند.

---

## ۳. معماری متغیرها

| Collection | تعداد | حالت‌ها (Modes) | محتوا |
|---|---|---|---|
| Primitives | ۱۳۹ | Value | رنگ‌های خام. از Library پنهان‌اند و scope ندارند، پس طراح مستقیم انتخابشان نمی‌کند. |
| Color | ۹۵ | Light (+ Dark بعد از ارتقا) | توکن‌های معنایی که به Primitives اشاره می‌کنند (alias). دو استثنا `bg/scrim` و `text/on-showcase-muted` (از 1.7.0، `#FFFFFFBD`) هستند: مقدار hex8 با شفافیت داخل خود مقدار، بدون alias. |
| Color · Dark | ۹۵ | Dark | فقط روی Starter. همان نام‌ها با مقدار تاریک. |
| Dimension | ۳۶ | Desktop (+ Touch بعد از ارتقا) | فاصله، گوشه، اندازهٔ کنترل، عرض منو، عرض کارت ورود (`size/auth-card`)، عرض دیالوگ (`size/dialog-sm`، `size/dialog-md`)، پهن‌ترین ستون فرم (`size/form-max`، از 1.9.0)، ضخامت مرز. |
| Dimension · Touch | ۳۶ | Touch | فقط روی Starter. اندازه‌های لمسی تبلت. |
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

**۴۴ مجموعهٔ variant با ۳۵۶ variant و ۹۷ کامپوننت تکی** (۷۱ تای آن آیکن است؛ از 1.8.0: Select، Textarea، CheckboxRow، Toast، Dialog، DialogBody و EmptyState تازه‌اند و TableCell حالت Loading گرفته است؛ از 1.9.0: FieldStatus، DataRow و FormActionBar تازه‌اند):

| صفحه | کامپوننت‌ها |
|---|---|
| Actions | Button (از 1.7.0 با `Variant=Link` و `State=Loading`)، IconButton |
| Forms & selection | Input (از 1.7.0 با محور `Type`: Text، Password، Code؛ از 1.9.0 با `Show prefix` و `Prefix` برای متن ثابت پیش از مقدار)، **Field** (از 1.7.0: برچسب، راهنما، شمارنده و خطا دور یک Input؛ از 1.9.0 با `Show status` برای خط وضعیت زیر کنترل)، **FieldStatus** (از 1.9.0: Checking، Success، Info، Critical)، **FormActionBar** (از 1.9.0: نوار ذخیرهٔ فرم، Inline و Sticky)، Checkbox، Switch، SegmentedControl (از 1.9.0 پنل Usage کاربرد radio group را برای پرسش‌های بله و خیر می‌گوید)، Tab، FilterChip |
| Status & feedback | Badge، StatusBadge، CountBadge، CertChip، HealthIndicator، Meter، DeadlineBadge، InfoBanner، Tooltip |
| Data display | IdentityTile، ProductThumb، Sparkline، StatTile، TrendChart، DonutProgress، SplitBar، WeeklyBars، CountdownRing |
| Tables & collections | TableCell، CardHeader، Pagination، BulkActionBar |
| Navigation & shell | NavItem، NavSubItem، NavGroupLabel، Sidebar، Topbar، **NavDrawer** و **BottomTabBar** (از 1.5.0، منوی موبایل D16) و **PhoneTopbar** (از 1.6.0، نوار بالای موبایل ۵۶ پیکسلی، Admin و Seller)؛ از 1.7.0: **BrandMark**، **Menu** و **MenuItem** (منوی حساب)، **AuthShowcase** (پنل کناری صفحه‌های ورود، Admin و Seller)، و در Topbar دو property تازهٔ `Show search` و `Show notifications` |
| Review & detail | QueueCard، ExtractedField، ChecklistItem (از 1.7.0 با حالت‌های Waiting و Needs attention و propertyهای `Show actions` و `Action`؛ از 1.9.0 با `Show detail`، `Detail` و `Show chevron`)، TimelineItem، **ReasonQuote** (از 1.7.0، دلیل تصمیم بازبین)، **DataRow** (از 1.9.0: یک مقدار یا دو مقدار برای مقایسه، پهن یا باریک (Narrow برای گوشی)، با حالت‌های Missing، Blocked و Changed و دو پیوند عملیات) |
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
7. **چگالی لمسی:** کامپوننت‌های تبلت و موبایل (OrderCard، Button Touch، IconButton Touch، NavDrawer، BottomTabBar) Touch density دارند: دکمهٔ ۴۸ پیکسلی و متن ۱۴ تا ۱۵ پیکسلی.

---

## ۶. قالب‌ها و تم تاریک

- **قالب‌ها** فقط از instanceهای کتابخانه ساخته شده‌اند: Admin (Home، Sellers، Certificate review) و Seller (Home، Orders، Order board تبلت). از 1.5.0 سه قالب موبایل ۳۶۰ پیکسلی هم هست: Seller Home با BottomTabBar، Seller با منوی باز روی scrim، Admin با منوی باز. از 1.6.0 نوار بالای موبایل (۵۶ پیکسل) کامپوننت PhoneTopbar است و هر سه قالب یک instance از آن دارند. پرده‌ی پشت کشو (scrim) به توکن `bg/scrim` bind شده است.
- از 1.7.0 صفحهٔ (روی Starter: Section) **Templates · Auth** صفحه‌های ورود و حساب پیش از پنل را دارد (ux.md ماژول identity، بخش 3.1، A1 تا A11): ۲۴ فریم Seller و ۱۷ فریم Admin در عرض ۱۲۸۰ (ستون فرم و AuthShowcase) و ۴ فریم ۳۶۰ پیکسلی (A1 و A7 برای هر دو پنل). Templates · Seller هم سه قالب «Seller · Your seller account» (S1: Awaiting approval، Changes needed، Not approved) و یک نسخهٔ موبایل Awaiting approval گرفته است.
- برای صفحهٔ جدید، یک قالب را کپی کنید. **پوسته (Sidebar و Topbar) را detach نکنید.** آیتم فعال منو را با property `State` روی NavItem تودرتو عوض کنید.
- از 1.9.0، در Templates · Seller فریم‌های **Seller · Setup** هم هست (ux.md ماژول sellers، بخش‌های 3.1 و 3.3): S1 در ۸ وضعیت فروشنده، گام‌های S2 تا S6 با حالت‌هایشان، دو صفحهٔ حالت‌ها برای نتیجهٔ شمارهٔ کسب‌وکار (S4) و وضعیت آدرس فروشگاه (S5)، و سه فریم موبایل با نوار ذخیرهٔ چسبان؛ روی هم ۳۲ فریم. گام‌های S2 تا S4 هم در حالت «پرونده تازه» (فیلدهای خالی، بدون «Saved») و هم «Saved» کشیده شده‌اند؛ Main گام‌های S2 تا S6 چگالی Touch دارد (هدف لمسی ۴۸ پیکسل در هر عرض، بخش 6 ux.md). فریم‌های «Seller · Your seller account» نسخهٔ 1.7.0 دست نخورده می‌مانند.
- **Dark preview** نُه قالب را در تم تاریک نشان می‌دهد (از 1.7.0: A1 Sign in برای Seller و Admin و «Seller · Your seller account · Changes needed»؛ از 1.9.0: S4 Business number · Saved، و S6 Review and submit در حالت‌های Missing و Blocked).
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
- [ ] **افزونه → Audit file** هیچ هشداری ندارد: رنگ بدون متغیر، متن بدون استایل، لایهٔ بیرون‌زده، کامپوننت بدون توضیح، Focus بدون حلقه، استایل افکت مغایر با spec.

---

## ۹. نسخه‌بندی

- **SemVer:**
  - MAJOR: تغییر نام یا حذف (توکن، کامپوننت، property).
  - MINOR: کامپوننت، variant یا توکن تازه.
  - PATCH: اصلاح مقدار یا ظاهر بدون تغییر API.
  - فقط فریم‌های قالب (Template frames only): PATCH.
- نسخه در افزونه (فیلد Version هنگام Export) و صفحهٔ Changelog ثبت می‌شود.
- نسخه‌های 1.1.0 تا 1.4.0 برای انتشارهای برنامه‌ریزی‌شدهٔ Auth، Panel، Seller setup و Seller admin رزرو شده بودند. به همین دلیل بعد از 1.0.0 مستقیم 1.5.0 آمد و بعد از آن 1.6.0. چون 1.5.0 و 1.6.0 زودتر منتشر شدند، محتوای 1.1.0 تا 1.4.0 حالا با شماره‌های آزاد بعدی منتشر می‌شود و از **1.7.0 Auth** شروع شد (در بخش 8.1 فایل ux.md ماژول identity با نام 1.1.0 برنامه‌ریزی شده بود). شماره‌های 1.1.0 تا 1.4.0 استفاده نمی‌شوند.
- **1.8.0 Panel (۷ اکتبر ۲۰۲۶):** توکن‌های `size/dialog-sm` (۴۰۰) و `size/dialog-md` (۵۶۰)، کامپوننت‌های Select، Textarea، CheckboxRow، Toast، Dialog، DialogBody و EmptyState، حالت Loading برای TableCell، مقدارهای ترجیحی Field (Input، Select، Textarea)، و قالب‌های Members، Roles، No access، Not found، Account security و دیالوگ‌های D1 تا D3 برای Admin (۱۵ فریم) و Seller (۱۸ فریم). Update library فقط روی فایل 1.7.0 به بالا کار می‌کند و پیام «Run 1.7.0 first» می‌دهد. نقش‌های نمونه جانگهدارند. Sellers list، role editor، دیالوگ‌های D4 تا D6 و unsaved-changes در 1.8.3 ساخته شدند.
- **1.9.0 Seller setup (۸ اکتبر ۲۰۲۶):** MINOR، همان «1.3.0 Seller setup» در بخش 8.1 ux.md فروشنده‌ها. توکن `size/form-max` (۶۴۰ پیکسل، پهن‌ترین ستون فرم)، آیکن‌های `pencil`، `refresh-cw` و `globe`، کامپوننت‌های FieldStatus، DataRow و FormActionBar، propertyهای تازهٔ Input، ChecklistItem و Field (لایه‌هایشان پنهان اضافه می‌شوند تا هیچ instance موجودی چیز تازه‌ای نشان ندهد)، یادداشت radio group در پنل Usage کامپوننت SegmentedControl، و ۳۲ فریم Seller · Setup با سه پیش‌نمایش تاریک. DataRow محور `Width` دارد (Narrow زیر ۷۶۰ پیکسل برچسب را بالای مقدار می‌گذارد) و ردیف Blocked با رنگ Attention، دلیل و پیوند «Contact us» نشان داده می‌شود. ترتیب FormActionBar در هر دو چیدمان یکی است (وضعیت، دکمهٔ دوم، دکمهٔ اصلی). نام فروشگاه نمونه «Kuraby Fresh» است، بدون واژهٔ گواهی. ux.md وضعیت Field را property `Status` نوشته بود؛ چون Field یک کامپوننت تکی است، وضعیت یک مجموعهٔ جدا (FieldStatus) است که در Field با `Show status` نشان داده می‌شود و «Status None» یعنی `Show status` خاموش.
- **1.8.4 Fixes from the 1.8.3 run (۸ اکتبر ۲۰۲۶):** PATCH، از اجرای 1.8.1 تا 1.8.3 در فایل واقعی. استایل‌های افکت Focus/Ring و Ring/Urgent پهنای سایه (spread) خود را دوباره می‌گیرند (۲ و ۴، و ۳ پیکسل). Figma هنگام وصل‌کردن رنگ سایه به متغیر، spread را صفر ذخیره کرده بود و حلقهٔ فوکوس و حلقهٔ فوری دیده نمی‌شدند. ناحیهٔ Main صفحه‌های موبایل افزونه که محتوایشان را می‌بُرند (۱۱ صفحه در ساخت تازه؛ نه ویرایشگر نقش موبایل و نه برگه‌های دیالوگ) عمودی اسکرول می‌شود، پس فهرستی بلندتر از صفحه (اعضا و نقش‌های فروشنده روی موبایل) زیر لبهٔ صفحه ادامه دارد و Audit آن را بیرون‌زده نمی‌شمارد. Audit file از هر نوع ۲۵ مورد را فهرست می‌کند و بقیه را می‌شمارد («… and N more»؛ بقیه بعد از اصلاح موردهای اول دیده می‌شوند) و استایل‌های افکت را با spec مقایسه می‌کند (از جمله اینکه رنگ حلقه‌ها هنوز به متغیر وصل باشد). Update library این‌ها را درجا اصلاح می‌کند و استایل یا فریمی را که دستی عوض شده گزارش می‌دهد و دست نمی‌زند.
- **1.8.3 Panel follow-up (۸ اکتبر ۲۰۲۶):** فقط فریم قالب (PATCH). در Templates · Admin فهرست فروشندگان P1 (`Admin · Sellers (Phase 2)`) با حالت‌های Menu open، View only، Loading، Empty و Load error و یک فریم ۳۶۰ پیکسلی، ویرایشگر نقش B3 (Custom، Default فقط‌خواندنی، System، Duplicate و Errors)، دیالوگ‌های D4 Reject (با حالت خطا و Sheet موبایل)، D4 View reason، D5 Suspend و D6 Add seller، و دیالوگ unsaved-changes. در Templates · Seller ویرایشگر نقش فروشنده (Custom، Ready-made، Owner و New role) و فریم ۳۶۰ پیکسلی آن. روی هم ۲۰ فریم (۱۵ ادمین، ۵ فروشنده) و ۵ کامپوننت بدنهٔ قالب. هیچ توکن، کامپوننت یا variantی تغییر نمی‌کند. Update library فقط فریم‌هایی را که فایل ندارد در ردیف‌های زیر فریم‌های موجود اضافه می‌کند. دیالوگ unsaved-changes صحنهٔ جدای `Dialogs · Role editor · Admin` دارد تا فریم 1.8.0 دست نخورد. در ویرایشگر نقش، مجوزی که ادمین خودش ندارد قفل می‌ماند و مقدار ذخیره‌شده‌اش عوض نمی‌شود؛ فقط Duplicate آن را کنار می‌گذارد (حسن، تست امنیت). برچسب «Owner's name» در D6 را هادی (مالک محصول) تعیین کرد و متن دیالوگ خروج بدون ذخیره را صاحب پروژه تأیید کرد. متن‌هایی که هنوز در ux.md نیستند و آنچه کشیده نشده در [`plugin/README.md`](plugin/README.md) آمده است.
- **1.8.2 Layout fixes (۷ اکتبر ۲۰۲۶):** از Audit فایل واقعی بعد از 1.7.0. variantهای Input با Type در ستون‌ها و AuthShowcase با یک variant در هر ردیف چیده می‌شوند، تا هر دو مجموعه و بلوک توضیحشان در صفحهٔ ۱۴۴۰ پیکسلی جا شوند. در فایل‌های Starter، بخشی که یک به‌روزرسانی بزرگش کرده دیگر روی بخش‌های بعدی نمی‌افتد: Update library بخشِ روی‌هم‌افتاده را از بخش قبلی رد می‌کند و بخش‌هایی را که روی هم نیستند (از جمله چیدمان دستی) جابه‌جا نمی‌کند. چیزی تغییر نام، بازسازی یا حذف نمی‌شود.
- **1.8.1 Audit fixes for the Panel pages (۷ اکتبر ۲۰۲۶):** صفحه‌های دسکتاپ Panel حداقل ارتفاع ۹۰۰ دارند، صفحهٔ موبایل اعضای ادمین ۳ کارت نشان می‌دهد، و CheckboxRow با Value در ستون‌ها چیده می‌شود. Update library فریم‌ها را درجا اصلاح می‌کند. Update library no longer moves existing frames; overlaps are reported.
- **1.7.0 Auth (۷ اکتبر ۲۰۲۶):** توکن‌های `bg/qr` (در هر دو تم سفید)، `bg/auth-showcase-admin` (`#0B1D2E`)، `bg/auth-showcase-seller` (`#06352E`)، `text/on-showcase`، `text/on-showcase-muted` (hex8، کنتراست دست‌کم 4.5:1 روی هر دو پنل) و `size/auth-card` (۴۰۰)، دو Primitive تازه، ۹ آیکن، کامپوننت‌های BrandMark، Field، ReasonQuote، Menu، MenuItem و AuthShowcase، variantها و propertyهای تازهٔ Button، Input، ChecklistItem و Topbar، و قالب‌های Auth و S1. فریم‌هایی که هنوز ساخته نشده‌اند (TODO) در [`plugin/README.md`](plugin/README.md) فهرست شده‌اند.
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
| ۳ صفحه در هر فایل | هر موضوع یک Section | Upgrade to modes → ۲۷ صفحه |
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
| Build library | ساخت کامل در فایل خالی. «Rebuild» هر چه افزونه ساخته پاک می‌کند و از نو می‌سازد. **روی کتابخانه‌ای که دستی ویرایش شده اجرا نشود؛ برای نسخهٔ تازهٔ افزونه از Update library استفاده کنید.** |
| Dark theme / Light theme | تعویض تم فریم‌های انتخاب‌شده |
| Touch density / Desktop density | تعویض تراکم فریم‌های انتخاب‌شده |
| Update library | روی فایلی که کتابخانه دارد، **فقط اضافه می‌کند** آنچه نسخهٔ جدید افزونه می‌آورد (متغیر، کامپوننت، قالب، ردیف Changelog، نسخه). تنها ویرایش روی چیزهای موجود، اصلاح‌های نام‌برده است و هر کدام در گزارش می‌آید. برای 1.5.0: فاصلهٔ ردیف‌های NavDrawer صفر می‌شود اگر به‌روزرسانی قبلی آن را با فاصله ساخته باشد. برای 1.6.0: پردهٔ پشت کشو در قالب‌های موبایل به `bg/scrim` با ۱۰۰٪ bind می‌شود و فریم قدیمی «Topbar · phone» با instance کامپوننت PhoneTopbar عوض می‌شود. همین فریم قدیمی تنها چیزی است که حذف می‌شود، و فقط داخل قالب موبایلی که خود افزونه ساخته. در بقیه چیزی حذف یا از نو ساخته نمی‌شود، چند بار اجرا شود اثری ندارد و روی فایل خالی اجرا نمی‌شود. برای 1.5.0: توکن `size/bottom-bar`، کامپوننت‌های NavDrawer و BottomTabBar و سه قالب موبایل. برای 1.6.0: توکن‌های `bg/scrim` و `size/topbar-phone`، آیکن `menu` و کامپوننت PhoneTopbar. برای 1.7.0: توکن‌ها، آیکن‌ها و کامپوننت‌های Auth، variantها و propertyهای تازهٔ Button، Input، ChecklistItem و Topbar، صفحهٔ Templates · Auth، قالب‌های S1 و سه پیش‌نمایش تاریک. variantهای موجود Input فقط نام `Type=Text, State=…` می‌گیرند تا محور Type اضافه شود. به مجموعه‌ای که افزونه نساخته (برچسب افزونه ندارد) چیزی اضافه نمی‌شود؛ رد شدنش و قالب‌هایی که به آن وابسته‌اند در گزارش می‌آید. **Sidebar موجود از نو ساخته نمی‌شود:** نشان برند کشیده‌شده‌اش می‌ماند و فقط ساخت تازه در Sidebar از BrandMark استفاده می‌کند. فایل 1.0.0، 1.5.0 یا 1.6.0 مستقیم به 1.7.0 می‌رسد. **از 1.8.0:** Update library فایل زیر 1.7.0 را رد می‌کند («Run 1.7.0 first»). افزوده‌ها: دو توکن `size/dialog-*`، Select، Textarea، CheckboxRow، Toast، Dialog، DialogBody، EmptyState، قالب‌های Panel. دو ویرایش روی چیزهای موجود، هر دو در گزارش: حالت `State=Loading` به TableCell و مقدارهای ترجیحی و توضیح Field. اصلاح‌های نام‌بردهٔ بعدی، هر کدام در گزارش: 1.8.1 حداقل ارتفاع ۹۰۰ صفحه‌های Panel، حذف کارت‌های عضوی که در صفحهٔ موبایل ادمین جا نمی‌شوند و چیدمان CheckboxRow؛ 1.8.2 چیدمان Input و AuthShowcase و جابه‌جایی بخش Starter که روی بخش قبلی افتاده؛ 1.8.4 spread استایل‌های حلقه و اسکرول Main صفحه‌های موبایل. **از 1.9.0:** توکن `size/form-max`، سه آیکن، FieldStatus، DataRow، FormActionBar و فریم‌های Seller · Setup اضافه می‌شوند. ویرایش‌های روی چیزهای موجود، هر کدام در گزارش: propertyهای تازه با لایه‌های پنهان در Input، ChecklistItem و Field (فقط روی کامپوننت‌های خود افزونه؛ variantی که لایه‌هایش دستی عوض شده رد و گزارش می‌شود)، توضیح این سه و SegmentedControl فقط وقتی هنوز همان متن قبلی را دارند، و یادداشت radio group در پنل Usage کامپوننت SegmentedControl. فریم‌ها فقط وقتی ساخته می‌شوند که همهٔ این‌ها سر جایشان باشد؛ وگرنه گزارش می‌گوید چه کم است. |
| Export tokens | ۷ فایل توکن از متغیرها و استایل‌های Figma |
| Audit file | lint کل فایل. روی نسخهٔ 1.6.0 در Figma واقعی (2026-10-07): ۱۲٬۷۷۰ لایه و صفر هشدار. روی نسخهٔ 1.8.3 (2026-10-08): ۳۴٬۳۶۷ لایه و ۲ لایهٔ بیرون‌زده در دو صفحهٔ موبایل فروشنده؛ Export همان روز نشان داد حلقه‌های فوکوس و فوری spread صفر دارند. هر دو در 1.8.4 اصلاح شدند. روی نسخهٔ 1.8.4 (2026-10-08): ۳۴٬۳۷۴ لایه و صفر هشدار در همهٔ بررسی‌ها؛ Export هر ۷ فایل را عیناً مثل ریپو داد |
| Upgrade to modes | بعد از ارتقای پلن |

توسعهٔ خود افزونه: [`plugin/README.md`](plugin/README.md). هر تغییر در افزونه باید `node test/run.js` را بدون خطا بگذراند. این تست با شبیه‌ساز سخت‌گیر API فیگما ۱۵ سناریو را اجرا می‌کند (از جمله «Update library» روی فایل‌هایی که افزونه‌های منتشرشدهٔ 1.6.0 تا 1.8.4 ساخته‌اند، و محافظ‌های به‌روزرسانی) و برابری Export با ریپو را می‌سنجد.

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
- **D16 منوی موبایل:** بسته شد (۲۰۲۶-۱۰-۰۷). از 1.5.0 NavDrawer، BottomTabBar، توکن `size/bottom-bar` و سه قالب ۳۶۰ پیکسلی را دارد و از 1.6.0 سه مورد باز هم بسته شد: توکن `bg/scrim` (روشن `#111827` با ۵۰٪، تاریک مشکی با ۶۰٪؛ شفافیت داخل مقدار است)، آیکن `menu` برای دکمهٔ منوی نوار بالا (`panel-left` فقط برای جمع‌کردن NavItem می‌ماند) و توکن `size/topbar-phone` (۵۶ پیکسل) همراه کامپوننت PhoneTopbar. **Board عمودی** هنوز کامپوننت ندارد.
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
