# معماری بین‌المللی‌سازی — MondaPac Marketplace Platform

**هدف سند:** طراحی هستهٔ پلتفرم به‌گونه‌ای که بدون بازنویسی، گسترش به نیوزیلند، مالزی، کشورهای اروپایی و آمریکا را بپذیرد.
**پیش‌نیاز مطالعه:** `horizontal-extensibility-architecture.md` — این سند بعد سوم (جغرافیا/بازار) را به همان الگوی Extension Point که برای Vertical طراحی شد اضافه می‌کند.

---

## ۱. اصل راهنما (تکرار همان انضباط قبلی)

در `CERT-*` حلال را و در سند توسعهٔ افقی «Vertical» را از هاردکد به یک بعد پیکربندی‌پذیر تبدیل کردیم. حالا **جغرافیا/بازار** سومین بعد است:

> **هسته هرگز نباید نام یک کشور، زبان یا ارز خاص را بشناسد.** `AUD`، `GST 10%`، `Australia` نباید در منطق Core ظاهر شوند — فقط در **داده‌های پیکربندی یک `Market`** مشخص. اگر کدی `if (country == 'AU')` داشته باشد، دقیقاً همان Code Smell قبلی است.

سه بعد پلتفرم اکنون این‌ها هستند: **Vertical** (چه می‌فروشیم) × **Market** (کجا می‌فروشیم) × **Tenant** (برای چه کسی — فعلاً فقط MondaPac، آماده برای SaaS احتمالی آینده). این سند فقط دربارهٔ بعد دوم است.

---

## ۲. موجودیت `Market` — قلب طراحی بین‌المللی

```
Market
 ├─ code (ISO 3166-1 alpha-2, مثل "AU", "NZ", "MY", "DE", "US")
 ├─ status: planned / soft_launch / active / suspended
 ├─ default_locale, supported_locales[]        // مثلاً NZ: en-NZ ؛ MY: ms-MY, en-MY, zh-MY
 ├─ default_currency, settlement_currency       // ارز نمایش پیش‌فرض در برابر ارزی که فروشنده واقعاً تسویه می‌شود
 ├─ tax_strategy_code                           // به TaxStrategy وصل می‌شود (بخش ۵)
 ├─ legal_entity_ref                            // کدام شرکت حقوقی این بازار را اداره می‌کند
 ├─ timezone
 ├─ active_certification_issuer_set             // زیرمجموعه‌ای از رجیستری CERT-04، مخصوص این بازار
 ├─ active_payment_providers[]                  // به PaymentProviderAdapter وصل می‌شود (بخش ۶)
 ├─ active_carriers[]                           // به FulfillmentStrategy موجود (SHP-*) وصل می‌شود
 └─ data_residency_requirement                  // none / eu_only / market_local (بخش ۸)
```

**قاعدهٔ سخت:** هر `Seller`، `Product Offer`، و `Order` به یک `market_id` وصل است. مشتری در لحظهٔ ورود (از دامنه/زیردامنه یا انتخاب دستی) در یک Market قرار می‌گیرد و فقط فروشندگان/کاتالوگ همان Market را می‌بیند — **خرید بین‌مارکتی (مثلاً مشتری در آلمان از فروشندهٔ استرالیایی) در فاز اول به‌صراحت خارج از محدوده است** (بخش ۱۰، سؤال باز ۱).

این دقیقاً همان seam ای است که در سند قبلی برای `tenant_id` توصیه کردیم: از روز اول ستون `market_id` روی جدول‌های هستهٔ Seller/Product/Order باشد، حتی اگر امروز فقط مقدار `"AU"` دارد.

---

## ۳. چندزبانگی (i18n / l10n)

### ۳.۱ چه چیزی نیاز به ترجمه دارد

| نوع محتوا | مکانیزم | وضعیت فعلی در سند قابلیت‌ها |
|---|---|---|
| نام/توضیح محصول، دسته | فیلد به‌ازای زبان | از قبل در `CAT-11` طراحی شده — فقط باید فهرست زبان‌ها از AU-only به `Market.supported_locales` وصل شود |
| ویژگی‌های فروشنده (Policies، Description) | فیلد به‌ازای زبان | از قبل در `SEL-21` طراحی شده |
| توضیح نوع گواهی (Halal، Kosher، Vegan) | فیلد به‌ازای زبان | از قبل در `CERT-01` طراحی شده |
| قالب ایمیل/پیامک تراکنشی | Translation Key + Locale | **جدید — باید اضافه شود**: هر قالب اعلان (`MSG-*`, `SEL-02`, `CERT-14`) یک کلید ترجمه می‌شود، نه متن ثابت |
| صفحات CMS (`STO-12`) | نسخهٔ جدا به‌ازای زبان | از قبل خلاصه پوشش داده شده |
| متن‌های ثابت رابط کاربری (دکمه‌ها، پیام خطا) | فایل i18n استاندارد فرانت‌اند (ICU Message Format) | **جدید — باید اضافه شود** |

### ۳.۲ راهبرد فنی
- **فرمت پیام:** ICU MessageFormat برای جمع/مفرد و متغیرهای درون‌جمله‌ای (مهم برای زبان‌هایی مثل آلمانی/مالایی با قواعد جمع متفاوت).
- **مسیریابی Locale:** `mondapac.com/en-AU/...`، `mondapac.com/de-DE/...` — نه Query String — تا SEO و Cache دوستانه باشد.
- **زنجیرهٔ Fallback:** `de-DE → de → en` تا محتوای ترجمه‌نشده به‌جای خالی ماندن، به انگلیسی برگردد (هرگز رشتهٔ خالی به کاربر نشان داده نشود).
- **گردش‌کار ترجمه:** محتوای کسب‌وکاری/حقوقی (سیاست بازگشت کالا، شرایط استفاده) ترجمهٔ انسانی اجباری؛ محتوای محصول می‌تواند با کمک AI شروع و با بازبینی انسانی تأیید شود (پیوند با `AIG-04` در سند قابلیت‌ها).
- **RTL:** در فهرست کشورهای فعلی (نیوزیلند، مالزی، اروپا، آمریکا) نیازی فوری به RTL نیست، ولی چون `STO-13` را از قبل برای فارسی/عربی احتمالی گذاشته بودیم، ساختار CSS باید از اول Logical Properties (`margin-inline-start` به‌جای `margin-left`) استفاده کند تا افزودن RTL بعداً هزینهٔ بازنویسی نداشته باشد.

---

## ۴. چندارزی (Multi-Currency)

### ۴.۱ مدل پول
```
Money = { amount: integer (واحد خرد ارز، مثل سنت), currency: ISO 4217 code }
```
همان قاعدهٔ `AU-03` (عدد صحیح، نه اعشار) اکنون **برای هر ارزی** اعمال می‌شود، نه فقط AUD.

### ۴.۲ ارز نمایشی در برابر ارز تسویه
- **ارز تسویه (Settlement Currency):** ارزی که فروشنده واقعاً در حساب خودش دریافت می‌کند — همیشه ارز `Market` فروشنده (مثلاً فروشندهٔ مالزیایی همیشه MYR می‌گیرد).
- **ارز نمایش (Display Currency):** قیمتی که مشتری می‌بیند. در فاز اول (چون خرید بین‌مارکتی خارج از محدوده است) این دو **همیشه یکی هستند** — پیچیدگی تبدیل نرخ ارز لحظه‌ای فقط وقتی لازم می‌شود که خرید بین‌مارکتی را فعال کنیم (بخش ۱۰).
- **نرخ ارز Snapshot:** اگر در آینده تبدیل لحظه‌ای لازم شد، نرخ باید در **لحظهٔ سفارش روی سفارش منجمد شود** — دقیقاً همان الگویی که برای نرخ کمیسیون (`COM-04`) استفاده کردیم؛ هرگز نرخ زندهٔ فعلی برای سفارش‌های قدیمی دوباره محاسبه نشود.

### ۴.۳ قیمت‌گذاری به‌ازای بازار
قیمت یک محصول در هر Market می‌تواند **مستقل** تعیین شود (نه صرفاً تبدیل نرخ ارز) چون مالیات، رقابت محلی و هزینهٔ لجستیک متفاوت است. این دقیقاً از `PricingStrategy` (Extension Point تعریف‌شده در سند توسعهٔ افقی) استفاده می‌کند — یک `MarketAwarePricingStrategy` که قیمت را به‌ازای `market_id` می‌خواند.

---

## ۵. مالیات به‌ازای بازار — `TaxStrategy` (Extension Point جدید)

این ششمین Extension Point است که به فهرست سند قبلی اضافه می‌شود:

```
interface TaxStrategy {
  marketCode: string
  computeTax(order, context): TaxBreakdown     // ممکن است چند خط مالیات برگرداند (مثلاً VAT + Duty)
  requiresTaxIdCollection(): boolean            // آیا شماره مالیاتی خریدار لازم است (B2B اروپا)
}
```

| بازار | رژیم مالیاتی | پیچیدگی | توصیهٔ پیاده‌سازی |
|---|---|---|---|
| استرالیا (فعلی) | GST ۱۰٪ یکنواخت | کم | داخلی، از قبل طراحی‌شده (`AU-02`) |
| نیوزیلند | GST ۱۵٪ یکنواخت | کم | همان الگوی استرالیا، فقط نرخ و رجیستری متفاوت (NZBN به‌جای ABN) |
| مالزی | SST (Sales & Service Tax)، نرخ متغیر بر اساس دستهٔ کالا | متوسط | نیازمند بررسی دقیق دسته‌بندی SST قبل از پیاده‌سازی — **در سند قابلیت‌ها هنوز عمیق بررسی نشده** |
| اتحادیهٔ اروپا | VAT متغیر به‌ازای کشور (۱۹٪ تا ۲۷٪)، طرح **OSS** (One-Stop-Shop) برای فروش بین‌مرزی داخل اتحادیه | **بالا** | به‌شدت توصیه می‌شود از یک سرویس مالیاتی شخص‌ثالث معتبر اروپا استفاده شود، نه محاسبهٔ دستی |
| آمریکا | مالیات فروش ایالتی، با قانون **Economic Nexus** (تعهد مالیاتی بر اساس حجم فروش در هر ایالت، نه فقط حضور فیزیکی) — هزاران نرخ محلی | **بسیار بالا** | **باید** از سرویس شخص‌ثالث (مثل Avalara یا TaxJar) استفاده شود؛ ساخت داخلی برای این پیچیدگی توجیه ندارد |

**تصمیم معماری:** `TaxStrategy` برای AU/NZ داخلی پیاده‌سازی می‌شود؛ برای EU/US از همان اول به‌عنوان یک Adapter به سرویس شخص‌ثالث طراحی شود، نه منطق داخلی — این یک تصمیم CTO-level است که باید در ADR ثبت شود (بخش ۹).

---

## ۶. پرداخت به‌ازای بازار — `PaymentProviderAdapter` (Extension Point جدید، هفتم)

```
interface PaymentProviderAdapter {
  marketCode: string
  supportedMethods(): PaymentMethod[]   // کارت، حواله بانکی، کیف پول محلی
  createPayout(seller, amount, currency): PayoutResult
}
```

| بازار | ملاحظات پرداخت |
|---|---|
| استرالیا/نیوزیلند | Stripe Connect (طبق تصمیم قبلی `AU-07`)؛ پشتیبانی خوب در هر دو کشور |
| مالزی | نیاز به بررسی پوشش Stripe Connect برای مالزی؛ روش‌های محلی رایج مثل FPX و کیف پول‌های محلی باید بررسی شوند |
| اروپا | SEPA برای حواله، iDEAL (هلند)، Giropay/Klarna (آلمان) روش‌های رایج‌اند؛ Stripe این‌ها را پوشش می‌دهد ولی باید فعال‌سازی به‌ازای کشور بررسی شود |
| آمریکا | ACH برای حواله، پوشش کامل Stripe |

هر Market لیست `active_payment_providers` خودش را دارد؛ افزودن یک بازار جدید یعنی پیاده‌سازی یک Adapter جدید (یا فعال‌سازی تنظیمات یک Provider موجود)، نه تغییر منطق Checkout.

---

## ۷. گواهی و انطباق قانونی به‌ازای بازار

چارچوب `CERT-*` از قبل عمومی طراحی شده بود — این سود همان تصمیم درست است:

- **رجیستری صادرکننده به‌ازای بازار:** `CERT-04` از قبل رجیستری صادرکننده دارد؛ فقط باید هر صادرکننده به یک یا چند `Market` وصل شود (مثلاً **JAKIM** برای مالزی مرجع اصلی و شناخته‌شدهٔ حلال است و باید در رجیستری Seed برای Market مالزی برجسته باشد؛ در اروپا و آمریکا صادرکنندگان متعدد و پراکنده‌تری وجود دارند).
- **قانون مصرف‌کننده به‌ازای بازار:** معادل `AU-05` (ACL) باید برای هر بازار جدا مستند شود: نیوزیلند (Consumer Guarantees Act)، اروپا (Consumer Rights Directive + قوانین ملی)، آمریکا (مقررات FTC + قوانین ایالتی). **این‌ها نیاز به بررسی حقوقی جدا دارند، نه فرض فنی.**
- **حریم خصوصی به‌ازای بازار:** این بخش از همه حساس‌تر است چون GDPR اروپا واقعاً از سخت‌گیرترین رژیم‌های دنیاست:

| بازار | قانون | نکتهٔ فنی |
|---|---|---|
| استرالیا | Privacy Act 1988 | از قبل در `AU-04` |
| نیوزیلند | Privacy Act 2020 | مشابه استرالیا، سخت‌گیری کمتر از GDPR |
| مالزی | PDPA (Personal Data Protection Act) | نیازمند بررسی جدا |
| اروپا | **GDPR** | حق فراموشی، انتقال‌پذیری داده، رضایت صریح، و **در بسیاری تفاسیر، الزام یا ترجیح قوی به نگهداری دادهٔ کاربران اروپایی داخل اتحادیه (Data Residency)** — بخش ۸ |
| آمریکا | قوانین ایالتی (مثل CCPA کالیفرنیا) به‌جای یک قانون فدرال یکپارچه | پیچیدگی از تنوع ایالتی می‌آید، نه یک قانون واحد |

---

## ۸. اقامت داده و توپولوژی زیرساخت (Data Residency)

**این مهم‌ترین تفاوت معماری بین AU/NZ و ورود به اروپاست.**

- GDPR به‌صراحت انتقال دادهٔ شخصی خارج از اتحادیهٔ اروپا را ممنوع نمی‌کند ولی شرایط سخت‌گیرانه‌ای (مثل SCC — Standard Contractual Clauses) می‌گذارد؛ **راهکار عملی و کم‌ریسک‌تر معمولاً میزبانی داده‌های کاربران اروپایی در یک منطقهٔ ابری داخل اتحادیه است.**
- این یعنی معماری زیرساخت باید از یک «یک منطقهٔ ابری واحد برای کل پلتفرم» به **«چند منطقهٔ ابری، به‌ازای Market»** حرکت کند — دقیقاً موضوع سند بعدی (راه‌اندازی Branch کشوری).
- فیلد `Market.data_residency_requirement` که در بخش ۲ تعریف شد، این تصمیم را در لایهٔ داده مستند می‌کند تا هم تیم Infra و هم تیم حقوقی به یک منبع واحد ارجاع دهند.

---

## ۹. پیش‌نویس ADR

```markdown
# ADR-0002: Market as a First-Class Dimension (i18n, Multi-Currency, Multi-Region Compliance)

## Context
MondaPac plans to expand from Australia into New Zealand, Malaysia, EU countries, and the
US. The core must not hardcode any country, currency, or language.

## Decision
1. Introduce a `Market` entity (country code, locales, currency, tax strategy, legal
   entity, timezone, certification issuer set, payment providers, carriers, data
   residency requirement) as a first-class dimension alongside the existing `Vertical`
   dimension (ADR-0001).
2. Every Seller, Product Offer, and Order carries a `market_id`. Cross-market shopping is
   explicitly out of scope for the initial rollout (see open question in the companion
   internationalization doc).
3. Add two new extension points to the registry established in ADR-0001: `TaxStrategy`
   and `PaymentProviderAdapter`, implemented per market.
4. Money is always `{ amount: integer minor units, currency: ISO 4217 }`; any FX
   conversion rate used for a cross-market order (if ever enabled) is snapshotted at
   order time, mirroring the existing commission-rate snapshot rule (COM-04).
5. For EU and US tax calculation, integrate a third-party tax compliance service rather
   than building VAT-OSS/US economic-nexus logic in-house.
6. Infrastructure moves from a single cloud region to a region-per-market topology where
   a Market's `data_residency_requirement` demands it (notably the EU).

## Consequences
- Adds a market-configuration layer to Seller/Product/Order from day one; low cost now
  (Australia is simply the first Market), high cost avoided later (no schema rewrite).
- EU and US tax/compliance complexity is deliberately pushed to specialized third parties
  instead of in-house logic, trading a recurring vendor cost for correctness and reduced
  legal risk.
- Requires legal review per market before launch (privacy law, consumer law, tax
  registration) — this ADR does not substitute for that review.

## Alternatives considered
- Hardcode Australia-only assumptions and rewrite per country when expansion happens:
  rejected — repeats the exact mistake corrected for certifications (HAL → CERT) and for
  business lines (ADR-0001); the cost of generalizing now is small compared to a schema
  rewrite later.
- Build tax calculation in-house for all markets: rejected for EU/US specifically, given
  the scale of ongoing regulatory maintenance required (VAT rate changes, US nexus
  threshold changes).
```

---

## ۱۰. سؤالات باز کسب‌وکاری (نیازمند تصمیم شما یا مشاور حقوقی/مالیاتی، نه فنی)

۱. **آیا خرید بین‌مارکتی** (مثلاً مشتری اروپایی از فروشندهٔ مالزیایی) در نقشهٔ راه هست، یا هر Market یک کاتالوگ/فروشندگان مستقل دارد؟ این تصمیم مستقیماً پیچیدگی تبدیل ارز لحظه‌ای و مالیات مرزی را تعیین می‌کند — توصیهٔ فنی: **شروع با بازارهای مستقل، بدون خرید بین‌مرزی**، چون پیچیدگی حقوقی/مالیاتی آن به‌تنهایی می‌تواند یک پروژهٔ جدا باشد.
۲. **آیا هر بازار یک شخصیت حقوقی جدا** (شرکت ثبت‌شده در همان کشور) خواهد داشت یا همه زیر یک شرکت مادر استرالیایی می‌فروشند؟ این روی الزامات مالیاتی، قراردادهای فروشنده و حتی انتخاب Payment Provider اثر مستقیم دارد.
۳. **کدام بازار اول** — پاسخ فنی این سؤال در سند بعدی (راه‌اندازی Branch) با معیار «شباهت قانونی/زبانی/ارزی به AU» پیشنهاد می‌شود، ولی تصمیم نهایی کسب‌وکاری است.
