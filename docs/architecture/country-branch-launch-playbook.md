# راه‌اندازی Branch های کشوری — مستند فنی

> **وضعیت (۲۰۲۶-۰۹-۳۰):** ADR-0003 با تصمیم مالک **Accepted** شد و دامنه‌اش گسترش یافت: معماری چندمارکتی از **فاز ۰** اعمال می‌شود، نه از زمان راه‌اندازی مارکت دوم (Region Stack، زمینهٔ مارکت اجباری، هویت کاربر به‌ازای مارکت، تست با دو fixture مارکت). متن نهایی و معتبر: `docs/adr/0003-regional-deployment-model.md`. پیش‌نویس ADR در بخش ۵ همین سند فقط سابقهٔ تاریخی است.

**پیش‌نیاز مطالعه:** `internationalization-architecture.md` (موجودیت `Market`، Extension Point های `TaxStrategy`/`PaymentProviderAdapter`) و `horizontal-extensibility-architecture.md` (اصل کلی توسعه‌پذیری).
**هدف سند:** پاسخ به این سؤال مشخص: وقتی تصمیم گرفتیم وارد یک کشور جدید شویم، **دقیقاً چه کاری فنی باید انجام شود** و **زیرساخت باید چه شکلی باشد**؟

---

## ۱. سه مدل ممکن برای راه‌اندازی Branch کشوری

| مدل | توضیح | ارزیابی |
|---|---|---|
| **الف) یک استقرار جهانی واحد** | یک کدبیس، یک زیرساخت، همه‌چیز در یک منطقهٔ ابری؛ تفاوت کشورها فقط از طریق داده (`Market`) اعمال می‌شود | ساده‌ترین عملیات، اما **با GDPR اروپا و نیاز به Latency پایین در بازارهای دور از هم سازگار نیست** |
| **ب) کدبیس مشترک، استقرار منطقه‌ای** | همان کدبیس (Modular Monolith + Market-aware)، ولی هر Market (یا گروهی از Marketهای نزدیک به‌هم) در یک منطقهٔ ابری جدا Deploy می‌شود | **توصیهٔ این سند** — تعادل بین سادگی توسعه و الزامات قانونی/عملکردی |
| **ج) کدبیس و زیرساخت کاملاً مستقل به‌ازای کشور (Franchise-style Fork)** | هر کشور عملاً یک پروژهٔ جدا | رد می‌شود — دقیقاً ضدالگویی که در سند توسعهٔ افقی هشدار دادیم؛ هر باگ باید N بار رفع شود |

**تصمیم:** مدل (ب). کدبیس همیشه یکی است (همان Repo، همان CI/CD)؛ آنچه به‌ازای کشور فرق می‌کند فقط **کجا Deploy می‌شود** و **کدام مقادیر `Market` فعال است**، نه خود کد.

### معیار تصمیم برای اینکه یک Market مستقل Deploy شود یا در زیرساخت مشترک بماند

| معیار | استقرار مشترک کافی است | نیاز به منطقهٔ اختصاصی |
|---|---|---|
| الزام قانونی اقامت داده | خیر | بله (مثل GDPR برای اتحادیهٔ اروپا) |
| فاصلهٔ جغرافیایی/Latency | نزدیک به منطقهٔ فعلی (مثلاً NZ به AU) | دور (اروپا/آمریکا نسبت به AU) |
| حجم ترافیک مورد انتظار در سال اول | کم | زیاد، توجیه‌کنندهٔ هزینهٔ منطقهٔ جدا |

**نتیجهٔ اعمال این معیارها روی چهار بازار هدف:**

| بازار | تصمیم استقرار | دلیل |
|---|---|---|
| نیوزیلند | **در همان منطقهٔ ابری استرالیا** (مثلاً `ap-southeast-2` سیدنی) | فاصلهٔ کم، بدون الزام اقامت دادهٔ سخت‌گیرانه، حجم اولیه کم |
| مالزی | **منطقهٔ آسیای جنوب‌شرقی جدا** (مثلاً `ap-southeast-1` سنگاپور) | Latency به AU قابل قبول است ولی نزدیک‌تر بودن به کاربر مالزیایی و احتمال الزامات PDPA توجیه‌کننده است |
| اتحادیهٔ اروپا | **منطقهٔ اروپایی اختصاصی، اجباری** (مثلاً `eu-central-1` فرانکفورت) | GDPR — این تنها گزینهٔ کم‌ریسک است، نه صرفاً بهینه‌سازی Latency |
| آمریکا | **منطقهٔ آمریکای شمالی اختصاصی** | حجم بازار به‌تنهایی توجیه‌کننده است؛ همچنین جدایی از پیچیدگی مالیاتی ایالتی در Adapter مربوطه |

**نکتهٔ معماری مهم:** حتی در استقرار منطقه‌ای، برخی سرویس‌های Core (مثلاً کاتالوگ محصولات مشترک بین‌المللی در آینده، اگر تصمیم به خرید بین‌مرزی گرفته شود) می‌توانند مشترک بمانند؛ امروز چون هر Market مستقل است (تصمیم بخش ۱۰ سند قبلی)، این پیچیدگی وجود ندارد — هر منطقه یک استقرار کامل و مستقل از پلتفرم را اجرا می‌کند که فقط کدبیس را با بقیه مشترک دارد.

---

## ۲. چک‌لیست راه‌اندازی یک کشور جدید

این چک‌لیست را برای هر Market جدید (نه فقط چهار موردی که اسم بردید) تکرار کنید. ترتیب پیشنهادی ستون‌ها = ترتیب واقعی اجرا.

### ۲.۱ حقوقی و مالی (قبل از هر کار فنی)
- [ ] ثبت شخصیت حقوقی محلی یا تأیید اینکه شرکت مادر می‌تواند بدون آن فعالیت کند (سؤال باز ۲ در سند قبلی)
- [ ] ثبت مالیاتی (ABN معادل محلی — مثلاً NZBN برای نیوزیلند)
- [ ] بررسی حقوقی قانون مصرف‌کننده و حریم خصوصی محلی (بخش ۷ سند قبلی)
- [ ] بررسی الزام اقامت داده (بخش ۸ سند قبلی) — تعیین‌کنندهٔ تصمیم استقرار در بخش ۱ همین سند

### ۲.۲ پیکربندی Market (فنی، سریع چون از قبل Seam آماده است)
- [ ] رکورد `Market` جدید با کد کشور، زبان(ها)، ارز، منطقهٔ زمانی
- [ ] پیاده‌سازی یا فعال‌سازی `TaxStrategy` مربوطه (داخلی برای AU/NZ، Adapter شخص‌ثالث برای EU/US)
- [ ] پیاده‌سازی یا فعال‌سازی `PaymentProviderAdapter` مربوطه
- [ ] Seed رجیستری صادرکنندگان گواهی محلی (`CERT-04`) — مثلاً JAKIM برای مالزی؛ **نیازمند تأیید متخصص محلی، نه فرض تیم فنی**
- [ ] اتصال Carrier های محلی (`SHP-02`)

### ۲.۳ محتوا و زبان
- [ ] ترجمهٔ محتوای حقوقی (شرایط استفاده، سیاست بازگشت کالا) — انسانی، نه ماشینی
- [ ] ترجمهٔ رابط کاربری و قالب‌های اعلان (بخش ۳ سند قبلی)
- [ ] بومی‌سازی قالب تاریخ/عدد/آدرس

### ۲.۴ زیرساخت
- [ ] تصمیم استقرار طبق جدول بخش ۱ (مشترک یا منطقهٔ اختصاصی)
- [ ] در صورت منطقهٔ اختصاصی: Pipeline استقرار جدید (همان کدبیس، پیکربندی محیط جدید)، DNS/زیردامنه (`mondapac.co.nz`، `mondapac.eu` یا `mondapac.com/en-EU` — تصمیم برندینگ، بخش ۳ همین سند)
- [ ] مانیتورینگ و Alerting برای منطقهٔ جدید

### ۲.۵ عملیات
- [ ] پشتیبانی مشتری با پوشش منطقهٔ زمانی محلی (حداقل هم‌پوشانی با ساعات کاری)
- [ ] برنامهٔ Soft Launch با تعداد محدود فروشندهٔ اولیه (شبیه فاز Beta که در PLAYBOOK اصلی برای MVP استرالیا داشتیم)

---

## ۳. تصمیم برندینگ دامنه (فنی، نیازمند تأیید نهایی بازاریابی)

| گزینه | مزیت | عیب |
|---|---|---|
| ccTLD به‌ازای کشور (`mondapac.co.nz`) | اعتماد محلی قوی، SEO محلی بهتر | مدیریت گواهی SSL/DNS بیشتر، برند تکه‌تکه‌تر |
| زیرمسیر روی دامنهٔ اصلی (`mondapac.com/en-NZ/`) | مدیریت ساده‌تر، برند یکپارچه | اعتماد محلی کمتر در برخی بازارها |
| زیردامنه (`nz.mondapac.com`) | تعادل بین دو گزینهٔ بالا | — |

**توصیهٔ فنی خنثی از منظر بازاریابی:** برای نیوزیلند (شباهت زیاد به AU) زیرمسیر یا زیردامنه کافی است؛ برای اروپا (چندکشوری با انتظار اعتماد محلی بالاتر) ccTLD به‌ازای کشور احتمالاً ارزش سرمایه‌گذاری دارد — این نهایتاً یک تصمیم برند است، نه صرفاً فنی.

---

## ۴. ترتیب پیشنهادی راه‌اندازی بازارها

معیار: شباهت قانونی/زبانی/ارزی به AU (هزینهٔ کمتر = اولویت بالاتر) **در کنار** تناسب استراتژیک با تمایز اصلی برند (اعتماد گواهی حلال).

| ترتیب | بازار | چرا این ترتیب |
|---|---|---|
| ۱ | **نیوزیلند** | کمترین فاصلهٔ قانونی/زبانی/ارزی؛ عملاً توسعهٔ همان Market استرالیا با چند مقدار پیکربندی متفاوت؛ کمترین ریسک برای اثبات صحت طراحی `Market` |
| ۲ | **مالزی** | پیچیدگی فنی متوسط (SST، PDPA) ولی **تناسب استراتژیک بسیار بالا** — بازار مسلمان بزرگ با اکوسیستم گواهی حلال قوی (JAKIM) که مستقیماً به تمایز برند (بیانیهٔ ماموریت شما) وصل است |
| ۳ | **اتحادیهٔ اروپا** | بالاترین پیچیدگی قانونی (GDPR، VAT-OSS چندکشوری، چندزبانگی واقعی) — نیازمند رزرو زمان و بودجهٔ حقوقی/مالیاتی جدی قبل از شروع فنی |
| ۴ | **آمریکا** | بزرگ‌ترین بازار ولی رقابتی‌ترین و پیچیده‌ترین از نظر مالیات ایالتی (Economic Nexus)؛ توصیه می‌شود آخر از همه، بعد از اثبات مدل در سه بازار قبلی |

این ترتیب صرفاً **پیشنهاد فنی بر اساس پیچیدگی و ریسک** است؛ اولویت واقعی کسب‌وکاری (مثلاً اگر یک فرصت سرمایه‌گذاری خاص در اروپا زودتر پیش بیاید) می‌تواند آن را تغییر دهد — این تصمیم نهایی شماست.

---

## ۵. پیش‌نویس ADR

```markdown
# ADR-0003: Regional Deployment Model for Country Branches

## Context
MondaPac will expand into New Zealand, Malaysia, the EU, and the US. Each new country
needs a technical launch path that doesn't fork the codebase and correctly handles data
residency (especially GDPR for the EU).

## Decision
1. One shared codebase (the existing modular monolith, Market-aware per ADR-0002) is
   deployed to region-specific infrastructure per Market, using the same CI/CD pipeline
   with per-region configuration/secrets.
2. Deployment region per Market is decided by: legal data-residency requirement,
   geographic latency, and expected first-year volume (see the decision table in the
   companion playbook). NZ shares infrastructure with AU; Malaysia gets a dedicated
   Southeast Asia region; the EU and US each get a dedicated region, the EU as a legal
   requirement rather than an optimization.
3. Each new Market launch follows the fixed checklist in the companion playbook (legal ->
   Market configuration -> content/localization -> infrastructure -> operations), in that
   order, with legal review gating everything after it.
4. Rollout order is NZ -> Malaysia -> EU -> US, based on legal/linguistic/currency
   complexity and strategic fit with the halal-certification differentiator (Malaysia),
   not purely market size.

## Consequences
- No franchise-style code forks; every bug fix and feature ships to all regions through
  the same pipeline.
- EU launch carries a mandatory dedicated-region cost from day one (not optional,
  GDPR-driven), which should be budgeted for explicitly rather than discovered late.
- Rollout order is a recommendation, not a constraint — the owner can reorder based on
  business opportunity, but each market still goes through the full checklist regardless
  of order.

## Alternatives considered
- Single global deployment for all markets: rejected due to GDPR data-residency risk and
  latency for geographically distant markets.
- Independent codebase per country: rejected — multiplies maintenance cost and
  contradicts the horizontal-extensibility principle already adopted (ADR-0001).
```

---

## ۶. سؤالات باز کسب‌وکاری

۱. آیا برای هر بازار یک تیم پشتیبانی/عملیات محلی استخدام می‌شود یا در فاز اول از راه دور (از استرالیا) پوشش داده می‌شود؟
۲. بودجهٔ راه‌اندازی اروپا (به‌خاطر الزام قانونی منطقهٔ اختصاصی و مشاورهٔ حقوقی GDPR/VAT) باید جدا از سه بازار دیگر در نظر گرفته شود — آیا این هزینه در نقشهٔ راه مالی فعلی لحاظ شده؟
۳. آیا استراتژی برندینگ دامنه (بخش ۳) باید همین حالا برای همهٔ بازارها یکسان تصمیم‌گیری شود یا به‌ازای هر بازار جدا بررسی شود؟
