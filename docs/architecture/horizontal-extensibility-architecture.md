# معماری توسعه‌پذیری افقی — MondaPac Marketplace Platform

**هدف سند:** طراحی هستهٔ پلتفرم به‌گونه‌ای که بدون بازنویسی، خطوط کسب‌وکار (Vertical) آینده — مارکت‌پلیس غذا/رستوران/کافی‌شاپ، مارکت‌پلیس Trade و ابزارآلات، و هر Vertical نامشخص دیگر — را بپذیرد.

---

## ۱. اصل راهنما

در طراحی چارچوب گواهی (فایل ۰۸ سند قابلیت‌ها)، «حلال» را از یک مفهوم هاردکدشده به یک نمونه از `CertificationType` عمومی تبدیل کردیم. همان انضباط دقیقاً باید برای «خط کسب‌وکار» هم اعمال شود:

> **هسته هرگز نباید نام یک Vertical خاص (حلال، غذا، Trade) را بشناسد.** هسته فقط مفاهیم عمومی می‌شناسد: `ProductType`، `FulfillmentStrategy`، `PricingStrategy`، `OrderWorkflow`. هر Vertical فقط یک **پیکربندی و مجموعه‌ای از پیاده‌سازی این Interfaceها** است، نه شاخه‌ای از کد هسته.

**قانون تست خودکار برای هر Pull Request:** اگر کدی در ماژول‌های Core حاوی `if (vertical == 'food')` یا مشابه آن باشد، این یک Code Smell جدی است و باید فوراً به `cto` گزارش شود — یعنی چیزی که باید Extension Point می‌شد، به‌اشتباه در Core هاردکد شده.

---

## ۲. Multi-Tenant: چه چیزی واقعاً لازم است؟

باید بین دو مفهوم که در پیام شما به‌هم نزدیک به نظر می‌رسند ولی هزینهٔ معماری‌شان بسیار متفاوت است، تفکیک قائل شد:

| مفهوم | تعریف | نمونه | هزینهٔ معماری |
|---|---|---|---|
| **چند Vertical داخلی (Multi-Line-of-Business)** | یک شرکت (MondaPac)، چند خط محصول مستقل روی یک زیرساخت مشترک | حلال retail + غذا/رستوران + Trade، همه متعلق به یک سازمان | **متوسط** — نیاز به Extension Point، نه Isolation کامل داده |
| **چند مستأجر سازمانی (True Multi-Tenant / SaaS)** | چند سازمان *مستقل* (مثلاً اگر روزی پلتفرم را به یک شرکت دیگر در نیوزیلند «اجاره» دهید) با داده‌ای که باید کاملاً از هم ایزوله باشد | مشتری B که پلتفرم خودش را روی زیرساخت شما اجرا می‌کند | **بالا** — Isolation داده، صورتحساب جدا، احتمالاً Schema-per-tenant |

**سند قابلیت‌ها (فایل ۰۶، کد `EXT-02 Multi-Tenant Ecommerce`) قبلاً این دومی را به‌عنوان یک قابلیت **P3 بسیار بلندمدت** علامت زده بود — این هنوز درست است.**

**توصیهٔ معماری:**
- **امروز:** فقط برای «چند Vertical داخلی» طراحی کن (هزینهٔ متوسط، ارزش فوری).
- **آماده‌سازی بدون پیاده‌سازی زودهنگام برای SaaS:** یک ستون `tenant_id` (یا `organization_id`) را از روز اول در جدول‌های هستهٔ اصلی (Seller، Order، Product) به‌عنوان یک فیلد اول‌کلاس بگذار، حتی اگر امروز فقط یک مقدار ثابت دارد (`tenant_id = 'mondapac'`). این ستون هزینهٔ امروز تقریباً صفر است، ولی نبودش یعنی روزی که SaaS واقعی لازم شد، باید هر جدول را Migrate کنی — دقیقاً همان درسی که در CERT-* یاد گرفتیم (هزینهٔ امروز کم، هزینهٔ تعویق زیاد).
- این یعنی معماری «Single-Tenant با Tenant Discriminator آماده»، نه Multi-Tenant کامل. Isolation فیزیکی (Schema-per-tenant/DB-per-tenant) را فقط وقتی SaaS واقعی به یک تصمیم کسب‌وکاری قطعی تبدیل شد اضافه کن.

---

## ۳. معماری Headless: مرزهای دقیق

```
┌──────────────────────────────────────────────────────────────────┐
│  Storefront: Halal Retail   │  Storefront: Food & Cafe  │  ...    │  ← اپ‌های Next.js جدا،
│  (Next.js)                  │  (Next.js)                │         │     هرکدام UX مخصوص Vertical
├──────────────────────────────────────────────────────────────────┤
│  BFF: Retail Channel        │  BFF: Food Channel        │  ...    │  ← لایهٔ تجمیع/تبدیل
│  (GraphQL/REST aggregation) │  (real-time order status) │         │     مخصوص هر کانال
├──────────────────────────────────────────────────────────────────┤
│                      Core Platform API (REST/GraphQL)              │  ← یک منبع حقیقت،
│         Seller | Catalog | Order | Payment | Certification         │     مستقل از Vertical
└──────────────────────────────────────────────────────────────────┘
```

**چرا این مرزبندی:**
- **Core API هرگز Vertical-aware نیست.** یک `POST /orders` عمومی است؛ رفتار خاص Vertical (مثلاً ETA لحظه‌ای تحویل غذا) در BFF یا در پیاده‌سازی‌های Extension Point اتفاق می‌افتد، نه در امضای API هسته.
- **هر Vertical یک Storefront مستقل می‌گیرد** (نه یک UI عمومی با کلی if/else) چون تجربهٔ کاربری غذا (سفارش سریع، تحویل لحظه‌ای) با Trade (درخواست قیمت، خرید عمده) اساساً متفاوت است؛ اشتراک فقط در Design System و کامپوننت‌های مشترک (مثل نشان گواهی `CERT-24`) است، نه در ساختار صفحه.
- **BFF جایی است که پیچیدگی مخصوص کانال جمع می‌شود** — اگر BFF نباشد، این پیچیدگی به Core نشت می‌کند و همان ضدالگویی می‌شود که در بخش ۱ ممنوع کردیم.

---

## ۴. الگوی Extension Point (Plugin Registry)

پنج نقطهٔ توسعهٔ اصلی که هسته باید به‌عنوان Interface (نه پیاده‌سازی) تعریف کند:

### ۴.۱ `ProductTypeHandler`
```
interface ProductTypeHandler {
  typeCode: string                          // نوع ساختاری: Simple | Configurable (ثبت در core) | نوع خاص یک Vertical (ثبت در verticals/<vertical>/)
  validateAttributes(attrs): ValidationResult
  renderSummary(product): ProductSummaryDTO  // برای Catalog API عمومی
}
```
**اصلاح بعد از G1 ماژول `catalog`:**
- `computeAvailability` از این Interface بیرون آمد. `catalog` قیمت و موجودی را نه نگه می‌دارد و نه می‌خواند، و هیچ facade، رویداد یا پاسخ آن قیمت، موجودی یا «قابل فروش الان» ندارد. اینکه کدام ماژول‌ها «قابل فروش الان» را ترکیب می‌کنند در دروازه‌های cart، `ordering`، `search` و ویترین تصمیم گرفته می‌شود (ADR-0024 تصمیم ۵؛ برگهٔ catalog بخش ۸ ناسازگاری ۱).
- `typeCode` نوع ساختاری محصول است، نه نام Vertical. core نوع‌های Simple و Configurable را ثبت می‌کند و نوع خاص یک Vertical در `verticals/` ثبت می‌شود (ADR-0001 تصمیم ۱ و ۵؛ برگهٔ catalog بخش ۵ و بخش ۸ ناسازگاری ۷).
هستهٔ فعلی (`CAT-*`) همین الگو را برای نوع‌های محصول دارد؛ فقط باید از یک enum بسته به یک **رجیستری باز** تبدیل شود که هر Vertical Module نوع خودش را ثبت می‌کند (دقیقاً معادل کاری که با `CertificationType` کردیم).

### ۴.۲ `FulfillmentStrategy`
```
interface FulfillmentStrategy {
  code: string                              // "carrier_shipping" | "table_delivery" | "freight_quote"
  estimateCompletion(order): TimeEstimate
  getTrackingModel(order): TrackingModel    // ثابت (کد رهگیری) یا لحظه‌ای (موقعیت زنده)
}
```
ماژول فعلی `SHP-*` (Self Ship / Carrier) خودش یک نمونه از این الگوست؛ فقط باید Interface آن عمومی و باز به رجیستری شود.

### ۴.۳ `PricingStrategy`
```
interface PricingStrategy {
  code: string                              // "fixed_catalog_price" | "quote_based" | "tiered_bulk"
  computePrice(item, context): Money
  requiresNegotiation(): boolean            // Trade نیاز به RFQ/Quote دارد، Retail ندارد
}
```

### ۴.۴ `OrderWorkflowExtension`
ماشین وضعیت پایهٔ سفارش (`ORD-*`) ثابت می‌ماند (`Pending → Paid → Fulfilling → Completed`) ولی هر Vertical می‌تواند **زیروضعیت‌های اختیاری** درون `Fulfilling` ثبت کند بدون تغییر ماشین اصلی — مثلاً غذا: `Preparing → Ready for Pickup → Out for Delivery`؛ Trade: `Quote Sent → Quote Accepted → Production`.

### ۴.۵ `AttributeSchema` (از قبل آماده)
مکانیزم ویژگی سفارشی که برای `SEL-20` (ویژگی فروشنده) و `CERT-01` (نوع گواهی) ساختیم، همان مکانیزمی است که برای فیلدهای مخصوص Vertical لازم است (مثلاً «زمان آماده‌سازی» برای غذا، «حداقل تیراژ سفارش» برای Trade) — **چیز جدیدی لازم نیست، فقط باید همین الگو را عمومی نگه داریم، نه Vertical-specific.**

---

## ۵. دو مثال عملی

### مثال الف — مارکت‌پلیس غذا/رستوران/کافی‌شاپ
| نیاز Vertical | پیاده‌سازی روی Extension Point موجود |
|---|---|
| منو به‌جای محصول فیزیکی | `ProductTypeHandler` جدید: `menu_item` — بدون Variant سنتی، با گزینه‌های افزودنی (Modifiers) از طریق `AttributeSchema` |
| تحویل لحظه‌ای با ETA | `FulfillmentStrategy` جدید: `real_time_delivery` — پیاده‌سازی جدید `getTrackingModel` با موقعیت زنده (نیاز به سرویس مکان‌یابی جدا، نه تغییر در Core Order) |
| وضعیت «در حال آماده‌سازی» | `OrderWorkflowExtension` برای زیروضعیت‌های `Fulfilling` |
| ساعات کاری رستوران | فیلد اختصاصی روی پروفایل فروشنده، از طریق مکانیزم `SEL-20` (ویژگی سفارشی)، نه فیلد هاردکد در جدول Seller هسته |

**هیچ‌کدام نیاز به تغییر schema هسته یا منطق `Order`/`Payment`/`Commission` ندارد.**

### مثال ب — مارکت‌پلیس Trade و ابزارآلات
| نیاز Vertical | پیاده‌سازی روی Extension Point موجود |
|---|---|
| درخواست قیمت (RFQ) به‌جای خرید فوری | `PricingStrategy` جدید: `quote_based` با `requiresNegotiation() = true`؛ یک جریان سفارش جدید قبل از Checkout استاندارد |
| قیمت پلکانی حجمی | `PricingStrategy` جدید: `tiered_bulk` |
| ارسال با بارنامه (Freight) | `FulfillmentStrategy` جدید: `freight_quote` |
| گواهی ایمنی/استاندارد ابزار | از همان `CERT-*` استفادهٔ مستقیم می‌شود — یک `CertificationType` جدید (مثلاً «ایمنی CE») بدون هیچ تغییر کد |

---

## ۶. کدام ماژول‌های فعلی امروز باید Extension Point شوند؟

| ماژول فعلی (سند قابلیت‌ها) | وضعیت پیشنهادی | چرا الان، نه بعداً |
|---|---|---|
| `CAT-*` (نوع محصول) | **باید امروز Extension Point شود** | نوع محصول عمیقاً در schema و منطق سفارش ریشه دارد؛ تعویق = بازنویسی سنگین |
| `SHP-*` (Fulfillment) | **باید امروز Extension Point شود** | همین الان هم Self Ship/Carrier دو استراتژی دارد؛ فقط باید رجیستری‌اش باز شود |
| `COM-*`/قیمت‌گذاری | **باید امروز Extension Point شود** | فرمول کمیسیون/قیمت در هسته و مالی حساس است؛ اضافه‌کردن بعدی پرریسک‌تر است |
| `ORD-*` (ماشین وضعیت اصلی) | **ثابت می‌ماند، فقط نقطهٔ توسعه برای زیروضعیت باز شود** | ماشین وضعیت اصلی (Pending/Paid/...) باید در همهٔ Verticalها یکسان بماند تا Payment/Commission ساده بمانند |
| `CERT-*` | **از قبل عمومی است — کاری لازم نیست** | همین الگو، نمونهٔ موفق قبلی ماست |
| `SEL-*` (فروشنده، ویژگی) | **از قبل با AttributeSchema پویاست — کاری لازم نیست** | |
| `INV-*`، `PAY-*`، `TRX-*` | **فعلاً عمومی کافی‌اند** | تفاوت Vertical در این‌ها کم است؛ اگر بعداً لازم شد (مثلاً موجودی فسادپذیر غذا) در همان زمان Extension Point اضافه شود |

---

## ۷. ریسک‌ها و ضدالگوها (از روز اول جلویشان گرفته شود)

1. **Premature Full Multi-Tenancy** — ساخت Schema-per-tenant یا DB-per-tenant امروز، بدون مشتری SaaS واقعی، هزینهٔ عملیاتی می‌سازد بدون ارزش. فقط `tenant_id` را آماده بگذار (بخش ۲).
2. **وراثت عمیق بین انواع محصول** — `MenuItem extends PhysicalProduct extends Product` یک تلهٔ کلاسیک است؛ باید Composition باشد (`ProductTypeHandler` که به یک `Product` عمومی متصل می‌شود)، نه زنجیرهٔ وراثت.
3. **نشت منطق Vertical به Core از طریق «فقط یک if کوچک»** — این‌طور شروع می‌شود و در عمل به بدهی فنی بزرگ تبدیل می‌شود؛ قانون بخش ۱ باید در Code Review و در Subagent `security-tester`/`qc-release-manager` اجرایی شود.
4. **UI عمومی «همه‌کاره»** — تلاش برای یک Storefront واحد که همهٔ Vertical ها را با تنظیمات نمایش دهد، معمولاً از هدفمندی UX هر Vertical می‌کاهد؛ Storefrontهای جدا (بخش ۳) ارزانتر از نگه‌داشتن یک UI بیش‌ازحد پیکربندی‌پذیر است.
5. **رویدادهای Event Bus با نام Vertical در آن‌ها** — نام رویداد باید `OrderPlaced` باشد، نه `FoodOrderPlaced`؛ Vertical در Payload/Metadata می‌آید، نه در نام Topic — وگرنه مصرف‌کنندگان رویداد (مثل Notification) باید هر Vertical را جدا بشناسند.

---

## ۸. اثر روی ADR، CLAUDE.md و PLAYBOOK

- **ADR جدید لازم است** (پیش‌نویس در بخش ۹) — باید در `docs/adr/` ذخیره و توسط `cto` تأیید شود.
- **CLAUDE.md** باید یک قانون کوتاه بگیرد: «هیچ نام Vertical در کد Core؛ همه‌چیز از طریق پنج Extension Point تعریف‌شده در ADR-XXX». این دقیقاً هم‌ردیف قانون طلایی CERT-21 است که قبلاً در CLAUDE.md گذاشتیم.
- **PLAYBOOK/فاز ۰-۱ (آماده‌سازی و اسکلت):** طراحی این پنج Interface باید در **همان فاز ۰** (تصمیمات معماری) اتفاق بیفتد، نه بعد از MVP — چون ستون `tenant_id` و شکل `ProductTypeHandler` روی Migration های اولیهٔ دیتابیس اثر می‌گذارند و تعویق آن‌ها گران است. این تغییری در حجم کار فاز ۰ نیست، فقط در طراحی آن.
- **بقیهٔ فازها بدون تغییر می‌مانند** — چون فقط داریم هسته را طوری طراحی می‌کنیم که *بعداً* بدون بازنویسی گسترش یابد؛ Vertical های جدید (غذا، Trade) خودشان هنوز در نقشهٔ راه فعلی نیستند.

---

## ۹. پیش‌نویس ADR

```markdown
# ADR-0001: Horizontal Extensibility via Core + Vertical Extension Points

## Context
MondaPac launches with a halal-retail vertical but intends to expand into unrelated
business lines (food & restaurant, trade/tools marketplace) without rewriting the core
platform. The core must not encode knowledge of any specific vertical.

## Decision
1. The platform core exposes five extension points as first-class interfaces:
   ProductTypeHandler, FulfillmentStrategy, PricingStrategy, OrderWorkflowExtension
   (sub-states only — the top-level order state machine stays fixed), and the existing
   dynamic AttributeSchema mechanism (already used for SEL-20/CERT-01).
2. Every table in the core schema (Seller, Product, Order) carries a `tenant_id` column
   from day one, defaulting to a single value today, to avoid a schema rewrite if true
   multi-tenant SaaS becomes a business requirement later.
3. Full data isolation (schema-per-tenant/DB-per-tenant) is explicitly OUT of scope until
   a real SaaS customer requirement exists — this ADR only reserves the seam, it does not
   implement isolation.
4. Each vertical ships as a separate headless storefront (Next.js app) consuming the same
   Core API through a vertical-specific BFF; the Core API itself remains vertical-agnostic.
5. No vertical name may appear in core module code, event topic names, or core schema.
   A CI/review check (enforced via the qc-release-manager and security-tester subagents)
   flags any conditional branching on a vertical identifier inside core modules.

## Consequences
- Slightly more upfront design cost in Phase 0/1 (interface design, tenant_id column).
- New verticals (food, trade) are added as new modules implementing existing interfaces,
  without touching Order/Payment/Commission core logic.
- Full SaaS multi-tenancy, if ever needed, requires additional work (data isolation,
  billing separation) but not a schema rewrite.

## Alternatives considered
- Full multi-tenant architecture now (schema-per-tenant): rejected — no current SaaS
  customer, premature operational cost.
- Vertical-specific forks/branches of the codebase: rejected — defeats the "buildable once,
  extensible many times" goal and duplicates core bug fixes across branches.
```

---

## ۹.۵. به‌روزرسانی: بعد سوم — Market (جغرافیا/بازار)

پس از تدوین این سند، چشم‌انداز گسترش به نیوزیلند، مالزی، اروپا و آمریکا مشخص شد. پلتفرم اکنون **سه** بعد توسعه‌پذیری افقی دارد، نه دو:

- **Vertical** (چه می‌فروشیم — حلال retail، غذا، Trade) — موضوع این سند
- **Market** (کجا می‌فروشیم — استرالیا، نیوزیلند، مالزی، اروپا، آمریکا) — موضوع سند جدید `internationalization-architecture.md`
- **Tenant** (برای چه کسی — فعلاً فقط MondaPac، Seam آماده برای SaaS احتمالی) — بخش ۲ همین سند

هر سه بعد از یک انضباط مشترک پیروی می‌کنند: **هسته نام هیچ نمونهٔ مشخصی از هیچ بعد را نمی‌شناسد**، فقط مفهوم عمومی بعد را. دو Extension Point جدید (`TaxStrategy`، `PaymentProviderAdapter`) برای بعد Market به فهرست پنج‌گانهٔ بخش ۴ اضافه شده‌اند — جزئیات کامل در `internationalization-architecture.md` و راهکار استقرار زیرساخت در `country-branch-launch-playbook.md`.

---

## ۱۰. سؤالات باز کسب‌وکاری (نه فنی — نیازمند تصمیم شما)

۱. آیا SaaS چندمستأجر (اجارهٔ پلتفرم به سازمان دیگر) واقعاً در افق ۵-۱۰ سالهٔ شما هست، یا فقط چند Vertical داخلی مدنظر است؟ این مستقیماً تعیین می‌کند چقدر روی Isolation کامل داده سرمایه‌گذاری کنیم.
۲. آیا Vertical های غذا/Trade در همان برند MondaPac عرضه می‌شوند یا زیربرندهای جدا می‌گیرند؟ این روی طراحی Storefront و Design System اثر دارد (بخش ۳).
۳. اولویت واقعی: آیا این طراحی همین الان (قبل از فاز ۰) باید قطعی شود، یا صرفاً می‌خواهید Seam آماده باشد و تصمیم نهایی Vertical دوم را بعد از اثبات MVP حلال بگیرید؟ (توصیهٔ فنی: گزینهٔ دوم — فقط Seam را امروز بگذارید.)
