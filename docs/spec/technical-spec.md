# سند مشخصات فنی (Technical Specification Document)
# MondaPac Marketplace Platform

**نسخه:** 2.0 (به‌روزرسانی‌شده با معماری سه‌بعدی توسعه‌پذیری افقی)
**تهیه‌کننده:** معماری ارشد نرم‌افزار
**نوع سند:** High-Level & Detailed Technical Specification

**اسناد تکمیلی که این نسخه بر پایهٔ آن‌هاست** (این سند خلاصهٔ یکپارچهٔ آن‌هاست؛ برای جزئیات به خودشان مراجعه کنید):
- `docs/architecture/horizontal-extensibility-architecture.md` — بعد Vertical، الگوی Extension Point، ADR-0001
- `docs/architecture/internationalization-architecture.md` — بعد Market، چندزبانگی/چندارزی، ADR-0002
- `docs/architecture/country-branch-launch-playbook.md` — مدل استقرار منطقه‌ای، ADR-0003
- `docs/features/00-INDEX.md` تا `09-internationalization.md` — سند قابلیت‌ها با کدهای یکتا (`SEL-*`, `CERT-*`, `INTL-*`, ...)

### تغییرات نسخهٔ ۲.۰ نسبت به ۱.۰
- الگوی معماری از «میکروسرویس به‌عنوان هدف اصلی» به **مونولیت ماژولار به‌عنوان تصمیم قطعی MVP** اصلاح شد (میکروسرویس فقط مسیر مهاجرت آینده است، نه معماری روز اول)
- بخش جدید **۱.۲ سه بعد توسعه‌پذیری افقی** اضافه شد (Vertical × Market × Tenant)
- ماژول **گواهینامه و مجوز (Certification & Compliance)** به فهرست ماژول‌های هسته اضافه شد
- **تصمیم قطعی:** خرید بین‌مارکتی در نقشهٔ راه نیست — هر Market (کشور) مستقل می‌ماند (کاتالوگ، فروشندگان و مشتریان جدا)؛ این تصمیم چندارزی را به‌شدت ساده می‌کند (بدون نیاز به تبدیل نرخ ارز لحظه‌ای)

### هم‌راستایی با ADRهای پذیرفته‌شده (اکتبر ۲۰۲۶)
هر جا ADRهای پذیرفته‌شده (`docs/adr/0001..0024`) یا برگه‌های ماژولِ تأییدشده متن این سند را عوض کرده‌اند، یادداشتی کنار همان متن آمده است. ADR و برگه بر این سند مقدم‌اند. هدف بلندمدت (میکروسرویس، Kafka، MongoDB، Elasticsearch) برای مرجع مانده است.

---

## بخش ۱ – معماری کلان سیستم (High-Level Architecture)

### ۱.۱ الگوی معماری پیشنهادی

الگوی پیشنهادی **میکروسرویس مبتنی بر رویداد (Event-Driven Microservices)** به همراه **Domain-Driven Design (DDD)** برای تعیین مرزهای سرویس (Bounded Context) است. دلایل انتخاب:

- مقیاس‌پذیری مستقل هر دامنه کسب‌وکار (سفارش، پرداخت، موجودی و...)
- امکان استقرار (Deployment) و تیم‌بندی مستقل (Team Topology بر اساس Conway's Law)
- تحمل خطا (Fault Isolation) در سیستم با ترافیک بالا
- پشتیبانی طبیعی از Peak Load (مثل Black Friday) با Auto-scaling سرویس‌محور

**تصمیم قطعی MVP (نه صرفاً پیشنهاد):** پلتفرم با **Modular Monolith** و مرزهای دامنهٔ صریح (هر ماژول: schema اختصاصی، ارتباط فقط از طریق Interface یا Domain Event) ساخته می‌شود و در صورت نیاز واقعی (نه پیش‌فرض)، با الگوی Strangler Fig به میکروسرویس مهاجرت می‌کند. دلیل این تصمیم: برای یک تیم کوچک، هزینهٔ عملیاتی ۱۴ سرویس/Kubernetes/Kafka از روز اول بر ارزش آن (مقیاس‌پذیری‌ای که هنوز لازم نیست) پیشی می‌گیرد. جدول‌های بالا (سرویس‌ها، Message Broker، Service Mesh) **معماری هدف بلندمدت** را نشان می‌دهند، نه معماری روز اول.

### ۱.۲ سه بعد توسعه‌پذیری افقی (Vertical × Market × Tenant)

پلتفرم از روز اول برای رشد در سه بعد مستقل طراحی می‌شود، نه فقط برای بازار حلال استرالیا:

| بعد | تعریف | وضعیت فعلی | سند مرجع |
|---|---|---|---|
| **Vertical** (چه می‌فروشیم) | خط کسب‌وکار — حلال retail، غذا/رستوران، Trade/ابزارآلات، هر Vertical آینده | فعال: فقط حلال retail؛ Seam آماده برای بقیه | `horizontal-extensibility-architecture.md` |
| **Market** (کجا می‌فروشیم) | کشور/بازار جغرافیایی — استرالیا، نیوزیلند، مالزی، اروپا، آمریکا | فعال: فقط `AU`؛ Seam آماده برای بقیه | `internationalization-architecture.md` |
| **Tenant** (برای چه کسی) | مستأجر سازمانی، در صورت SaaS احتمالی آینده | غیرفعال؛ فقط ستون آماده، بدون Isolation کامل | `horizontal-extensibility-architecture.md` بخش ۲ |

**قانون طلایی معماری (روی هر سه بعد اعمال می‌شود):** هستهٔ سیستم هرگز نام یک نمونهٔ مشخص از هیچ بعدی را نمی‌شناسد — نه «حلال»، نه «Australia»، نه یک Tenant خاص. هرکدام فقط یک ردیف پیکربندی/رجیستری‌اند. هفت Extension Point این را ممکن می‌کنند:

`ProductTypeHandler` · `FulfillmentStrategy` · `PricingStrategy` · `OrderWorkflowExtension` · `AttributeSchema` (چهار مورد اول برای بعد Vertical) · `TaxStrategy` · `PaymentProviderAdapter` (دو مورد آخر برای بعد Market)

**تصمیم قطعی دربارهٔ خرید بین‌مارکتی:** هر Market مستقل است — مشتری فقط فروشندگان/کاتالوگ Market خودش را می‌بیند. یک سفارش همیشه در یک ارز واحد است (ارز Market)؛ نیازی به تبدیل نرخ ارز لحظه‌ای یا Snapshot نرخ ارز در MVP یا نسخه‌های بعدی (تا اطلاع ثانوی) نیست. این تصمیم پیچیدگی مالی/محاسباتی پلتفرم را به‌طور قابل‌توجهی کاهش می‌دهد.

### ۱.۳ دیاگرام لایه‌ها (Layered Architecture)

```
┌─────────────────────────────────────────────────────────┐
│  Presentation Layer                                       │
│  Web App (Next.js/React) | Mobile App | Admin Panel       │
│  API Gateway (Kong/AWS API Gateway) | BFF Layer            │
├─────────────────────────────────────────────────────────┤
│  Application Layer                                         │
│  Use Cases / Orchestrators / Command & Query Handlers      │
│  (CQRS Mediators, Application Services, DTO Mapping)       │
├─────────────────────────────────────────────────────────┤
│  Domain Layer                                               │
│  Aggregates, Entities, Value Objects, Domain Events        │
│  Business Rules (Order, Pricing, Inventory, Loyalty)        │
├─────────────────────────────────────────────────────────┤
│  Infrastructure Layer                                       │
│  Databases | Message Broker | Cache | External APIs        │
│  (Payment Gateway, Shipping Providers, SMS/Email)           │
└─────────────────────────────────────────────────────────┘
```

### ۱.۴ لیست ماژول‌های مستقل (در MVP: ماژول‌های مونولیت ماژولار؛ در بلندمدت: کاندید میکروسرویس)

| # | نام ماژول | مسئولیت اصلی |
|---|-----------|----------------|
| 1 | User Service | مدیریت حساب کاربری، پروفایل، احراز هویت پایه *(در MVP ردیف ۱ و ۲ یک ماژول‌اند: `identity`؛ ADR-0008 تصمیم ۳)* |
| 2 | Auth & Identity Service | نشست سمت سرور، نه JWT (ADR-0018 تصمیم ۲)؛ نقش و مجوز پویا برای هر دو پنل (ADR-0018 تصمیم ۴)؛ OAuth2 و SSO فقط هدف بلندمدت‌اند (برگهٔ identity بخش ۳) |
| 3 | Product Catalog Service | مدیریت محصولات، دسته‌بندی، ویژگی‌ها، SEO metadata؛ نوع محصول از طریق `ProductTypeHandler` توسعه‌پذیر |
| 4 | Inventory Service | مدیریت موجودی، رزرو انبار، هماهنگی چند انبار |
| 5 | Pricing & Promotion Service | قیمت‌گذاری پویا، تخفیف‌ها، کدهای تخفیف؛ از طریق `PricingStrategy` توسعه‌پذیر به‌ازای Vertical/Market *(در MVP ماژول P0 `pricing`: قیمت، قیمت ویژه و Cost به‌ازای (Offer، Variant) و نگه‌داشتن جهش قیمت؛ ADR-0008 تصمیم ۳، ADR-0024 تصمیم ۱ و ۴)* |
| 6 | Cart Service | مدیریت سبد خرید (Session-based / Persistent)، همیشه محدود به یک Market |
| 7 | Order Service | ثبت، مدیریت چرخه حیات و وضعیت سفارش؛ زیروضعیت‌های اختصاصی از طریق `OrderWorkflowExtension` |
| 8 | Payment Service | ارتباط با درگاه‌های پرداخت، تسویه، Refund؛ Provider به‌ازای Market از طریق `PaymentProviderAdapter` |
| 9 | Shipping & Logistics Service | محاسبه هزینه ارسال، انتخاب Carrier، ردیابی مرسوله؛ از طریق `FulfillmentStrategy` توسعه‌پذیر |
| 10 | Search & Recommendation Service | جستجوی محصول (Elasticsearch)، پیشنهاد هوشمند |
| 11 | **Certification & Compliance Service** *(جدید در نسخهٔ ۲.۰)* | چارچوب عمومی گواهی/مجوز (حلال، کوشر، وگان، و آینده) — `CERT-*`، تعریف نوع گواهی، رجیستری صادرکننده، اجرای قانون سخت «بدون گواهی معتبر، بدون برچسب» |
| 12 | Tax Service | محاسبهٔ مالیات به‌ازای Market از طریق `TaxStrategy`؛ برای بازارهای پیچیده (اروپا/آمریکا) Adapter به سرویس شخص‌ثالث |
| 13 | Review & Rating Service | نظرات و امتیازدهی کاربران |
| 14 | Notification Service | ارسال ایمیل، SMS، Push Notification؛ قالب‌ها چندزبانه (`INTL-11`) |
| 15 | Seller/Vendor Management Service | مدیریت فروشندگان شخص ثالث (Marketplace)، ویژگی‌های پویا (`SEL-20`) *(در MVP ماژول P0 `sellers`؛ ADR-0008 تصمیم ۳)* |
| 16 | Analytics & Reporting Service | گزارش‌گیری، داشبورد BI |

**نکتهٔ مهم:** `Market` و `Tenant` در این فهرست **سرویس مجزا نیستند** — هر دو داده‌های پیکربندی‌ای‌اند که همهٔ ماژول‌های بالا (به‌ویژه Catalog، Order، Payment، Tax) از طریق `market_id`/`tenant_id` به آن‌ها ارجاع می‌دهند؛ ساختن یک «Market Service» جدا در این مقیاس توجیه ندارد.

**فهرست ماژول‌های MVP:** مرجع ADR-0008 تصمیم ۳ است (با اصلاح ADR-0019: `assistant` در P1). جدول بالا نام‌های هدف بلندمدت را نگه می‌دارد.

### ۱.۵ ارتباطات بین سرویس‌ها

**ارتباط همزمان (Synchronous):**
- REST API برای ارتباطات خارجی (Client ↔ API Gateway ↔ Services)
- gRPC برای ارتباطات داخلی با نیاز به تأخیر پایین (مثلاً Inventory ↔ Order در لحظه Checkout)

**ارتباط ناهمزمان (Asynchronous):**
- Message Broker (Kafka یا RabbitMQ) برای رویدادهای دامنه مانند:
  - `OrderCreated`, `PaymentCompleted`, `InventoryReserved`, `ShipmentDispatched`
- استفاده از الگوی **Publish/Subscribe** برای Decoupling کامل سرویس‌ها
- **Outbox Pattern** برای تضمین Consistency بین دیتابیس و انتشار پیام
- **قاعدهٔ نام‌گذاری رویداد:** نام رویداد هرگز نام یک Vertical یا Market را در خود ندارد (`OrderPlaced`، نه `HalalOrderPlacedAU`)؛ این اطلاعات در Payload/Metadata می‌آید، وگرنه مصرف‌کنندگان رویداد (Notification و...) باید هر نمونه را جدا بشناسند

**در MVP جایگزین شده با ADR-0006 و ADR-0008:** Kafka یا RabbitMQ در MVP نیست. رویدادها با Outbox تراکنشی و یک Event Bus درون‌فرایندی پایدار منتشر می‌شوند (ADR-0006 تصمیم ۲ تا ۴). broker واقعی بعداً فقط با یک ADR تازه، به‌عنوان adapter دیگر، اضافه می‌شود (ADR-0006 تصمیم ۸). ارتباط همزمان بین ماژول‌ها در MVP فراخوانی facade درون‌فرایندی است، نه gRPC (ADR-0008 تصمیم ۵). Kafka و gRPC هدف بلندمدت می‌مانند.

### ۱.۶ مدیریت داده‌ها

- **در MVP (مونولیت ماژولار):** هر ماژول Schema اختصاصی خودش را دارد (نه لزوماً پایگاه‌دادهٔ فیزیکی جدا)؛ ممنوعیت Join مستقیم بین Schema ماژول‌ها، ارتباط فقط از طریق Interface یا Event. در مهاجرت بعدی به میکروسرویس، این مرز به «Database per Service» فیزیکی تبدیل می‌شود.
- **ابعاد افقی روی Schema:** جدول‌های `Seller`، `Product`، `Order` از روز اول ستون‌های `market_id` و `tenant_id` دارند (حتی با تک‌مقدار امروز) تا مهاجرت به چند Market/Tenant واقعی، بازنویسی Schema نخواهد.
- **پول:** هر مبلغ `{amount: عدد صحیح واحد خرد ارز, currency: ISO 4217}`؛ چون خرید بین‌مارکتی در نقشهٔ راه نیست (تصمیم قطعی)، هیچ نرخ ارزی هرگز نیازی به تبدیل یا Snapshot ندارد — فقط نرخ کمیسیون (`COM-04`) به همین شکل در لحظهٔ سفارش منجمد می‌شود.
- **Saga Pattern (Choreography-based)** برای تراکنش‌های توزیع‌شده مانند فرآیند Checkout (Order → Payment → Inventory → Shipping)
- **CQRS** برای ماژول‌های با حجم خواندن بالا مانند Catalog و Search (جداسازی مدل Write از Read)
- **Event Sourcing** پیشنهادی برای Order Service جهت حفظ تاریخچه کامل تغییرات وضعیت سفارش *(در MVP جایگزین شده با ADR-0004 تصمیم ۱: جدول تاریخچهٔ وضعیتِ فقط‌افزودنی به‌علاوهٔ رویدادهای دامنه، نه Event Sourcing)*
- **Eventual Consistency** به عنوان استراتژی پیش‌فرض بین Bounded Context ها

### ۱.۷ زیرساخت ابری پیشنهادی

| مؤلفه | تکنولوژی پیشنهادی |
|-------|---------------------|
| Containerization | Docker |
| Orchestration | Kubernetes (EKS/GKE/AKS) |
| Service Mesh | Istio یا Linkerd |
| API Gateway | Kong / AWS API Gateway |
| Cache | Redis (Cluster Mode) |
| CDN | Cloudflare / AWS CloudFront |
| Message Broker | Apache Kafka |
| Object Storage | AWS S3 / MinIO |
| Primary Database | PostgreSQL (Transactional) |
| NoSQL Database | MongoDB (Catalog) + Elasticsearch (Search) |
| Secrets Management | HashiCorp Vault |

**در MVP جایگزین شده با ADR-0004 و ADR-0006:** ذخیره‌سازهای MVP فقط PostgreSQL، Redis و object storage سازگار با S3 هستند (ADR-0004 تصمیم ۱). MongoDB، Elasticsearch و Event Store در MVP نیستند؛ جستجو با full-text خود PostgreSQL شروع می‌شود و Elasticsearch فقط با یک ADR تازه در P1 دوباره بررسی می‌شود. Message Broker در MVP نیست (ADR-0006). ذخیره‌ساز محلی دیگر MinIO نیست و با اولین برشی که فایل ذخیره می‌کند انتخاب می‌شود (ADR-0016). این جدول هدف بلندمدت است.

**استقرار منطقه‌ای (Regional Deployment):** یک کدبیس، ولی استقرار در منطقهٔ ابری متفاوت به‌ازای Market، بسته به الزام اقامت داده/Latency/حجم — نیوزیلند در همان منطقهٔ استرالیا، مالزی در منطقهٔ جنوب‌شرق آسیا، اتحادیهٔ اروپا و آمریکا هرکدام منطقهٔ اختصاصی (اروپا به‌دلیل GDPR الزامی، نه اختیاری). جزئیات کامل در `country-branch-launch-playbook.md`. Kubernetes/Service Mesh در فهرست بالا **معماری هدف پس از اثبات MVP** است؛ راه‌اندازی اولیهٔ استرالیا با Docker Compose/یک سرویس Container ساده (بخش Stack در `CLAUDE.md`) کافی است.

---

## بخش ۲ – لیست کامل ماژول‌های عملکردی (Functional Modules)

**یادداشت دربارهٔ خطوط «ذخیره‌سازی» این بخش:** در MVP جایگزین شده با ADR-0004 (تصمیم ۱؛ این ADR انتخاب ذخیره‌ساز در بخش ۲ را برای MVP کنار می‌گذارد). MongoDB، Elasticsearch و Event Store هدف بلندمدت‌اند. هر ماژول در MVP schema خودش را در PostgreSQL دارد (ADR-0004 تصمیم ۲).

### ۲.۱ ماژول‌های هسته (Core – MVP اجباری)

> **ماژول ۱ و ۲ در MVP یک ماژول‌اند: `identity`** (ADR-0008 تصمیم ۳؛ برگهٔ identity بخش ۸ مورد ۱۰). مالک آدرس‌های مشتری هنوز تعیین نشده است: ADR-0008 آن را نام نبرده و G2 ماژول `identity` آن را بیرون از دامنهٔ خود نگه داشته است (`docs/design/domain/identity.md`)؛ مالک در دروازهٔ cart یا `ordering` مشخص می‌شود (برگهٔ identity بخش ۳).

**۱. ماژول مدیریت کاربران (User Management)**
- زیرماژول‌ها: ثبت‌نام/ورود، مدیریت پروفایل، آدرس‌های کاربر، مدیریت نقش‌ها
- وابستگی: Auth Service *(در MVP همان ماژول `identity`)*
- ورودی/خروجی: ورودی اطلاعات ثبت‌نام، خروجی نشست و پروفایل کاربر *(نشست سمت سرور، نه توکن JWT؛ ADR-0018 تصمیم ۲)*
- ذخیره‌سازی: PostgreSQL (جدول Users, Addresses) *(مالک Addresses: یادداشت بالا)*

**۲. ماژول احراز هویت و مجوز (Auth & Authorization)**
- زیرماژول‌ها: نشست سمت سرور (ADR-0018 تصمیم ۲)، RBAC پویا با نقش سیستمی، پیش‌فرض و دلخواه برای هر دو پنل (ADR-0018 تصمیم ۴؛ ADM-05، PNL-05)، عامل دوم (ADR-0018 تصمیم ۵). Social Login بعد از راه‌اندازی (برگهٔ identity تصمیم ۴)
- وابستگی: User Service *(در MVP همان ماژول `identity`)*
- ورودی/خروجی: ورودی Credentials، خروجی نشست سمت سرور: توکن مات که فقط hash آن ذخیره می‌شود (ADR-0018 تصمیم ۲؛ جای Access/Refresh Token را گرفت، برگهٔ identity بخش ۸ مورد ۱۳)
- ذخیره‌سازی: PostgreSQL (نشست‌ها). بدون deny-list توکن؛ در فاز ۲ بدون cache نشست یا مجوز (ADR-0018 تصمیم ۲، اصلاح ADR-0004 تصمیم ۱)

**۳. ماژول کاتالوگ محصول (Product Catalog)**
- زیرماژول‌ها: مدیریت محصول، دسته‌بندی، ویژگی‌های Variant (رنگ/سایز)، تصاویر محصول؛ همهٔ فروش از راه Offer (ADR-0010)
- وابستگی: هیچ‌کدام از Inventory و Pricing. جهت برعکس است: `pricing` و `inventory` به facade و رویدادهای `catalog` وابسته‌اند و `catalog` قیمت و موجودی را نه نگه می‌دارد و نه می‌خواند (ADR-0024 تصمیم ۵؛ جایگزین خط قبلی «Inventory, Pricing»)
- ورودی/خروجی: ورودی داده محصول از Admin/Seller، خروجی JSON محصول برای Frontend
- ذخیره‌سازی: MongoDB (Schema-flexible)

**۴. ماژول مدیریت موجودی (Inventory Management)**
- زیرماژول‌ها: موجودی چندانباره، رزرو موجودی، هشدار کمبود کالا
- وابستگی: Order, Product Catalog
- ورودی/خروجی: ورودی رویداد سفارش، خروجی وضعیت موجودی به‌روز
- ذخیره‌سازی: PostgreSQL با Optimistic Locking

**۵. ماژول سبد خرید (Shopping Cart)**
- زیرماژول‌ها: افزودن/حذف آیتم، محاسبه قیمت لحظه‌ای، ادغام سبد مهمان با کاربر ثبت‌نام‌شده
- وابستگی: Product Catalog, Pricing
- ورودی/خروجی: ورودی SKU و تعداد، خروجی سبد به‌روزشده
- ذخیره‌سازی: Redis (TTL-based) *(در MVP: PostgreSQL و Redis فقط cache؛ ADR-0004 تصمیم ۱ و G1 برگهٔ cart)*

**۶. ماژول ثبت و مدیریت سفارش (Order Management)**
- زیرماژول‌ها: Checkout، تاریخچه سفارش، مدیریت وضعیت (Pending/Confirmed/Shipped)
- وابستگی: Cart, Payment, Inventory, Shipping
- ورودی/خروجی: ورودی سبد نهایی، خروجی شناسه سفارش و رسید
- ذخیره‌سازی: PostgreSQL + Event Store

**۷. ماژول پرداخت (Payment Processing)**
- زیرماژول‌ها: اتصال به درگاه، مدیریت تراکنش، بازپرداخت (Refund)
- وابستگی: Order Service
- ورودی/خروجی: ورودی اطلاعات پرداخت، خروجی وضعیت تراکنش
- ذخیره‌سازی: PostgreSQL (رمزنگاری‌شده، PCI-DSS Compliant)

**۸. ماژول ارسال و لجستیک (Shipping & Fulfillment)**
- زیرماژول‌ها: محاسبه هزینه ارسال، انتخاب Carrier، ردیابی مرسوله
- وابستگی: Order, Inventory
- ورودی/خروجی: ورودی آدرس و وزن بسته، خروجی کد رهگیری
- ذخیره‌سازی: PostgreSQL

**۹. ماژول جستجو (Search)**
- زیرماژول‌ها: ایندکس‌گذاری محصول، فیلتر پیشرفته، Autocomplete
- وابستگی: Product Catalog
- ورودی/خروجی: ورودی Query متنی، خروجی نتایج رتبه‌بندی‌شده
- ذخیره‌سازی: Elasticsearch

**۱۰. ماژول اعلان‌ها (Notifications)**
- زیرماژول‌ها: ایمیل تراکنشی، SMS، Push Notification؛ قالب‌ها چندزبانه با Fallback (`INTL-11..13`)
- وابستگی: تمامی سرویس‌های Event-Producer
- ورودی/خروجی: ورودی رویداد سیستم، خروجی پیام ارسال‌شده
- ذخیره‌سازی: MongoDB (Log پیام‌ها)

**۱۱. ماژول گواهینامه و مجوز (Certification & Compliance)** *(جدید در نسخهٔ ۲.۰)*
- زیرماژول‌ها: تعریف نوع گواهی (`CertificationType`)، رجیستری صادرکننده به‌ازای Market، گواهی فروشنده با ماشین وضعیت (Draft→Pending→Approved/Rejected→Expired/Revoked)، گواهی تولیدکننده و سیاست مبنای ادعا (ADR-0012)، تصمیم ادعا برای برچسب Offer (`evaluateClaim`). خود برچسب روی Offer است و `catalog` آن را نگه می‌دارد (ADR-0010 تصمیم ۲)
- وابستگی: Seller، Product Catalog
- ورودی/خروجی: ورودی مدرک/ادعای فروشنده، خروجی تصمیم ادعا (`evaluateClaim`) برای برچسب گواهی روی Offer
- ذخیره‌سازی: PostgreSQL
- **قانون سخت دامنه:** هیچ Offerی برچسب گواهی نمی‌گیرد، مگر: فروشندهٔ همان Offer گواهی معتبر، تأییدشده و منقضی‌نشده از همان نوع داشته باشد؛ یا سیاست مبنای ادعای دسته مبنای تولیدکننده را مجاز کند، یک گواهی تولیدکنندهٔ تأییدشده و منقضی‌نشده از همان نوع محصول را پوشش دهد، و Offer از نوع SEALED_ORIGINAL با تعهد فروشنده برای همان Offer باشد (ADR-0012). بدون سیاست، گواهی فروشنده لازم است. محتوای محصول هرگز ادعای گواهی ندارد. اجرا فقط از راه `evaluateClaim` است. این قانون برای حلال، کوشر، وگان و هر نوع آیندهٔ دیگر یکسان اعمال می‌شود (سند قابلیت‌ها فایل ۰۸؛ ADR-0010؛ برگهٔ certification بخش ۸ ناسازگاری ۱۹)

### ۲.۲ ماژول‌های کمکی (Supporting – افزایش کارایی)

**۱۲. ماژول نظرات و امتیازدهی (Review & Rating)**
- زیرماژول‌ها: ثبت نظر، تعدیل محتوا (Moderation)، امتیاز میانگین
- وابستگی: Product Catalog, User
- ذخیره‌سازی: MongoDB

**۱۳. ماژول تخفیف و کوپن (Promotion Engine)**
- زیرماژول‌ها: کد تخفیف، تخفیف حجمی، کمپین‌های زمان‌دار
- وابستگی: Cart, Pricing
- ذخیره‌سازی: PostgreSQL + Redis Cache

**۱۴. ماژول مدیریت فروشندگان (Vendor/Marketplace)**

> در MVP ماژول P0 `sellers` است، نه ماژول کمکی (ADR-0008 تصمیم ۳). ثبت‌نام حساب مال `identity` و تسویه مال `commission-payouts` است (ADR-0008 تصمیم ۳؛ برگهٔ sellers بخش ۸ ناسازگاری ۱۱). وضعیت دسترسی فروشنده را `identity` نگه می‌دارد و قرارداد «اجازهٔ فروش» در `sellers` است (ADR-0022). شناسهٔ کسب‌وکار (برای AU: ABN) پروفایل مالیاتی با پیکربندی Market است (ADR-0007 تصمیم ۶) و گواهی‌ها مال `certification` (CERT-*) هستند.

- زیرماژول‌ها: ثبت‌نام فروشنده، پنل مدیریت فروشگاه، تسویه‌حساب فروشنده
- وابستگی: Product Catalog, Order, Payment
- ذخیره‌سازی: PostgreSQL

**۱۵. ماژول پشتیبانی مشتری (Customer Support/Ticketing)**
- زیرماژول‌ها: تیکتینگ، چت آنلاین، مرجوعی کالا (Return/RMA)
- وابستگی: Order Service
- ذخیره‌سازی: MongoDB

**۱۶. ماژول مدیریت محتوا (CMS)**
- زیرماژول‌ها: بنر صفحه اصلی، صفحات استاتیک، بلاگ؛ محتوای حقوقی (شرایط استفاده، بازگشت کالا) به‌ازای زبان با ترجمهٔ انسانی (`INTL-12`)
- وابستگی: مستقل
- ذخیره‌سازی: MongoDB/Headless CMS

### ۲.۳ ماژول‌های پیشرفته (Advanced – مقیاس‌پذیری و شخصی‌سازی)

> AI در MVP توانایی مقطعی است، نه ماژول جدا در این فهرست: ADR-0019 (هستهٔ راه‌اندازی، قواعد AI و محل کد آن). اولویت ماژول‌های ۱۷، ۲۰ و ۲۱ عوض نمی‌شود و P3 می‌ماند.

**۱۷. ماژول توصیه‌گر هوشمند (Recommendation Engine)**
- زیرماژول‌ها: Collaborative Filtering، Content-based، Real-time Personalization
- وابستگی: Search, User Behavior Analytics
- ذخیره‌سازی: Data Lake + Feature Store

**۱۸. ماژول تحلیل رفتار کاربر (Behavioral Analytics)**
- زیرماژول‌ها: Clickstream Tracking، Funnel Analysis، A/B Testing
- وابستگی: تمامی سرویس‌های Frontend-facing
- ذخیره‌سازی: ClickHouse/BigQuery

**۱۹. ماژول برنامه وفاداری (Loyalty & Rewards)**
- زیرماژول‌ها: امتیاز خرید، سطح‌بندی مشتری (Tier)، کش‌بک
- وابستگی: Order, User
- ذخیره‌سازی: PostgreSQL

**۲۰. ماژول مدیریت قیمت پویا (Dynamic Pricing)**
- زیرماژول‌ها: قیمت‌گذاری بر اساس تقاضا، رقابت، موجودی
- وابستگی: Pricing, Analytics
- ذخیره‌سازی: PostgreSQL + Real-time Stream Processing

**۲۱. ماژول تشخیص تقلب (Fraud Detection)**
- زیرماژول‌ها: تحلیل الگوی تراکنش، Risk Scoring، Blacklist Management
- وابستگی: Payment, Order
- ذخیره‌سازی: Data Lake + ML Model Serving

---

## بخش ۳ – امکانات و خصوصیات غیرعملکردی (Non-Functional Requirements)

### ۳.۱ الزامات امنیتی
1. احراز هویت چندعاملی (MFA) برای پنل ادمین و کاربران با سطح دسترسی بالا *(تعریف در MVP: برای ادمین از روز اول الزامی؛ برای فروشنده در راه‌اندازی اختیاری، و برای Seller Owner قبل از فعال شدن تسویه و تغییر حساب تسویه الزامی؛ فقط اپ رمزساز، بدون پیامک — ADR-0018 تصمیم ۵؛ برگهٔ identity بخش ۸ مورد ۱۷)*
2. استفاده از OAuth2/OpenID Connect برای Federation و Social Login *(هدف بلندمدت؛ در راه‌اندازی فقط ایمیل و رمز برای همه — برگهٔ identity تصمیم ۴)*
3. رمزنگاری داده در حالت سکون (AES-256) و در حال انتقال (TLS 1.3)
4. پیاده‌سازی کامل کنترل‌های OWASP Top 10 (SQLi, XSS, CSRF, SSRF, Broken Auth)
5. Rate Limiting و Bot Protection در API Gateway (WAF)
6. توکنایز کردن اطلاعات کارت بانکی (PCI-DSS Level 1 Compliance)
7. مدیریت Secrets با Vault، بدون Hardcode در کد

### ۳.۲ الزامات کارایی
8. زمان پاسخ API زیر ۲۰۰ میلی‌ثانیه برای ۹۵٪ درخواست‌ها (P95 Latency)
9. پشتیبانی از حداقل ۵۰,۰۰۰ درخواست همزمان در پیک ترافیک
10. استراتژی کش چندلایه: CDN (Static Assets)، Redis (Session/Cart)، Application-level Cache (Catalog) *(در MVP Redis منبع نشست و سبد نیست: نشست‌ها در PostgreSQL، ADR-0018 تصمیم ۲؛ سبد در PostgreSQL، ADR-0004 تصمیم ۱)*
11. Lazy Loading و Pagination برای لیست محصولات با حجم بالا

### ۳.۳ الزامات دسترس‌پذیری
12. SLA هدف: ۹۹.۹۵٪ (حداکثر ~۴.۴ ساعت Downtime در سال)
13. RTO (Recovery Time Objective): کمتر از ۱۵ دقیقه
14. RPO (Recovery Point Objective): کمتر از ۵ دقیقه (با Replication همزمان)
15. معماری **Active-Active Multi-Region** برای سرویس‌های حیاتی (Order, Payment)

### ۳.۴ الزامات مقیاس‌پذیری
16. Auto-scaling افقی بر اساس CPU Utilization، Queue Length و Request Rate
17. مقیاس‌پذیری مستقل هر Microservice متناسب با بار کاری خاص خود
18. استفاده از Read Replica برای دیتابیس‌های با بار خواندن بالا (Catalog, Search)

### ۳.۵ الزامات یکپارچه‌سازی
19. API Gateway مرکزی برای مدیریت نسخه‌بندی، Throttling و Authentication
20. پشتیبانی از Webhook برای اطلاع‌رسانی به فروشندگان/سرویس‌های شخص ثالث
21. Event Bus مرکزی (Kafka) برای یکپارچگی رویدادمحور بین دامنه‌ها *(در MVP جایگزین شده با ADR-0006: Outbox و Event Bus درون‌فرایندی پایدار؛ Kafka هدف بلندمدت)*

### ۳.۶ الزامات نظارت و لاگ‌گیری
22. متمرکزسازی لاگ با پشته ELK (Elasticsearch, Logstash, Kibana)
23. مانیتورینگ متریک با Prometheus + Grafana Dashboard
24. Distributed Tracing با Jaeger/OpenTelemetry برای ردیابی درخواست بین سرویس‌ها
25. Alerting خودکار (PagerDuty/Opsgenie) بر اساس SLO Breach

---

## بخش ۴ – ماتریس اولویت‌بندی پیاده‌سازی (Implementation Priority Matrix)

| اولویت | ماژول/ویژگی | زمان تخمینی (هفته) | وابستگی فنی |
|--------|--------------|----------------------|----------------|
| P0 | User Management + Auth (در MVP یک ماژول: `identity`؛ ADR-0008 تصمیم ۳) | برآورد نشده (۳ هفتهٔ قبلی دیگر معتبر نیست؛ ADR-0018 پیامدها) | - |
| P0 | Seller Management (`sellers`؛ ADR-0008 تصمیم ۳؛ قبلاً P2 با نام Vendor Management) | برآورد نشده | User Management (`identity` شناسهٔ فروشنده را می‌سازد؛ ADR-0022 تصمیم ۱) |
| P0 | Product Catalog | برآورد نشده (۴ هفتهٔ قبلی باورپذیر نیست؛ برگهٔ catalog بخش ۸) | User Management |
| P0 | Pricing (`pricing`؛ ADR-0008 تصمیم ۳، ADR-0024 تصمیم ۱ و ۲؛ فاز ۴ PLAYBOOK) | برآورد نشده | Product Catalog (facade و رویدادها؛ ADR-0024 تصمیم ۵) |
| P0 | Cart Service | 2 | Product Catalog |
| P0 | Order Service | 4 | Cart, Inventory |
| P0 | Payment Service | 4 | Order Service |
| P0 | Inventory Service | 3 | Product Catalog |
| P0 | Extension Point Scaffolding (Vertical/Market Seam) | 1 | - (بخشی از فاز ۰، نه یک ماژول کاربری جدا) |
| P0 | Certification & Compliance | برآورد نشده (برآورد فاز ۳ در G2 می‌آید؛ برگهٔ catalog بخش ۸) | Seller, Product Catalog |
| P1 | Shipping & Logistics *(در MVP، SHP-01 در P0 است؛ ADR-0008 تصمیم ۳)* | 3 | Order Service |
| P1 | Search Service | 3 | Product Catalog |
| P1 | Notification Service | 2 | Event Bus |
| P1 | API Gateway & Security Hardening | 2 | تمام سرویس‌های P0 |
| P2 | Review & Rating | 2 | Product, User |
| P2 | Promotion Engine | 3 | Cart, Pricing |
| P2 | Customer Support/RMA | 3 | Order Service |
| P3 | Recommendation Engine | 5 | Search, Analytics |
| P3 | Behavioral Analytics | 4 | تمام سرویس‌های Frontend |
| P3 | Loyalty & Rewards | 3 | Order, User |
| P3 | Dynamic Pricing | 5 | Pricing, Analytics |
| P3 | Fraud Detection | 5 | Payment, Order |

### توضیح اولویت‌بندی P0

ماژول‌های P0 (User Management، Catalog، Cart، Order، Payment، Inventory، Certification؛ و طبق ADR-0008 تصمیم ۳ همچنین `sellers`، `pricing`، `commission-payouts`، `tax` و `shipping` (SHP-01)؛ مرجع فهرست کامل P0 همان تصمیم است) هسته اصلی چرخه درآمدزایی (Revenue Loop) و تمایز برند پلتفرم را تشکیل می‌دهند؛ بدون این‌ها امکان انجام یک تراکنش خرید کامل **و قابل‌اعتماد** (با گواهی معتبر) وجود ندارد. «Extension Point Scaffolding» یک ردیف جدا نیست چون کار مستقلی برای کاربر نهایی نمی‌سازد، بلکه طراحی هفت Interface بخش ۱.۲ است که باید **همان فاز ۰** (قبل از Migration های اولیهٔ دیتابیس) قطعی شود — تعویق آن یعنی بازنویسی Schema بعداً. این ماژول‌ها:

- **بالاترین ریسک کسب‌وکار** را در صورت عدم پیاده‌سازی دارند (توقف کامل درآمد)
- **وابستگی معکوس** بالایی دارند؛ اکثر ماژول‌های P1 تا P3 به آن‌ها متکی هستند
- پایه‌ی صحت داده‌ای (Data Integrity) کل سیستم را تشکیل می‌دهند (به‌ویژه Order و Payment که نیازمند Consistency بالا هستند)

ماژول‌های P1 تجربه کاربری و عملیات پس از خرید را تکمیل می‌کنند، P2 ارزش افزوده کسب‌وکاری (Marketplace, Retention) ایجاد می‌کنند و P3 لایه هوشمندسازی و بهینه‌سازی سود را روی هسته پایدار اضافه می‌کنند.

---

## جدول خلاصه تکنولوژی‌های پیشنهادی به تفکیک لایه

| لایه | تکنولوژی پیشنهادی |
|------|----------------------|
| Presentation (Web) | Next.js / React, TypeScript |
| Presentation (Mobile) | React Native / Flutter |
| API Gateway | Kong / AWS API Gateway |
| Application/Backend | Node.js 24.20.0+ (ADR-0014، ADR-0021)، NestJS، Prisma v7 (ADR-0004) — پیش‌فرض تصمیم‌گرفته‌شده در `CLAUDE.md` |
| Communication (Sync) | REST, gRPC |
| Communication (Async) | Apache Kafka |
| Domain/Business Logic | DDD + Hexagonal Architecture |
| Relational Database | PostgreSQL |
| NoSQL Database | MongoDB |
| Search Engine | Elasticsearch |
| Cache | Redis Cluster |
| Object Storage | AWS S3 / MinIO |
| CDN | Cloudflare / AWS CloudFront |
| Containerization | Docker |
| Orchestration | Kubernetes |
| Service Mesh | Istio |
| CI/CD | GitHub Actions / GitLab CI + ArgoCD |
| Monitoring | Prometheus + Grafana |
| Logging | ELK Stack |
| Tracing | Jaeger / OpenTelemetry |
| Secrets Management | HashiCorp Vault |
| Analytics/BI | ClickHouse / BigQuery |
| Tax/Compliance (EU/US) | سرویس شخص‌ثالث (مثل Avalara/TaxJar) به‌جای منطق داخلی — تصمیم `INTL-32/33` |
| Payment (Marketplace Payout) | Stripe Connect، به‌ازای Market از طریق `PaymentProviderAdapter` |

**در MVP جایگزین شده:** ردیف‌های Communication (Async)، NoSQL Database و Search Engine با ADR-0004 و ADR-0006 (PostgreSQL، Redis، object storage؛ Outbox و Event Bus درون‌فرایندی). Object Storage محلی دیگر MinIO نیست (ADR-0016). این جدول هدف بلندمدت است.

---

**پایان سند**
