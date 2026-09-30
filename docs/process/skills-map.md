# نقشهٔ استفاده از Skillها در پروژه

**تصمیم صاحب پروژه (۲۰۲۶-۱۰-۰۱):** در همهٔ مراحل و بخش‌های پروژه، skillهای مرتبطِ نصب‌شده در اکانت Claude استفاده شوند؛ هر جا skill لازم نبود یا کم بود، پیشنهاد skill جدید داده شود.

**قاعدهٔ اجرا:** قبل از شروع هر کار، جلسهٔ اصلی (ارکستریتور) در این جدول نگاه می‌کند و skill مرتبط را **پیش از** نوشتن خروجی بارگذاری می‌کند. skillها روش کار و قالب خروجی را می‌دهند؛ قوانین پروژه (CLAUDE.md، ADRها، دروازه‌های ADR-0013) همیشه بر آن‌ها مقدم‌اند. اگر skill با یک ADR تعارض داشت، ADR ملاک است و تعارض به علی (cto) گزارش می‌شود.

> **نکته دربارهٔ محیط:** skillهای اکانت در جلسه‌های Cowork/claude.ai در دسترس‌اند. اگر بخشی از کار (مثلاً کدنویسی فاز ۱) در Claude Code روی سیستم صاحب پروژه اجرا شود، باید بررسی شود که همین skillها آنجا هم نصب‌اند؛ اگر نیستند، این جدول فقط راهنمای روش کار است.

## ۱. تصمیم‌گیری، دروازه‌ها و معماری

| کار | skill | نقش مسئول |
|---|---|---|
| نوشتن/بازبینی ADR | `engineering:architecture` | علی (cto)، محمد (software-architect) |
| طراحی ماژول در G2 (مرز، API، داده) | `engineering:system-design` | محمد |
| پیش‌نویس برگهٔ ماژول در G1 | `product-management:write-spec` | هادی (product-owner) |
| بررسی ایدهٔ جدید صاحب پروژه قبل از برگه (مثل حلالِ گواهی تولیدکننده) | `product-management:product-brainstorming` | هادی، محمد |
| تحلیل رقبا (مارکت‌پلیس‌های حلال و محلی) هنگام تعیین دامنه | `product-management:competitive-brief` | هادی |
| تغییر دامنه بعد از دروازه (کنترل تغییر ADR-0013) | `operations:change-request` | هادی، علی |
| انتخاب سرویس/محصول بیرونی (CMS برای ADR-0011، Identity، Stripe، میزبانی، tax agent) | `operations:vendor-review` | علی، محمد |
| نمودار جریان‌های پیچیده برای مرور با صاحب پروژه | `artifact-diagramming`، `artifact-design` | محمد، جعفر |

## ۲. کنترل پروژه (جواد، scrum-master)

| کار | skill |
|---|---|
| برنامهٔ اسپرینت | `product-management:sprint-planning` |
| به‌روزرسانی نقشهٔ راه و اولویت فازها | `product-management:roadmap-update` (با هادی) |
| وضعیت روزانه | `engineering:standup` |
| گزارش وضعیت به صاحب پروژه در پایان اسپرینت/فاز | `operations:status-report`، `product-management:stakeholder-update` |
| ارزیابی و بهبود فرآیند | `operations:process-optimization` |
| ثبت ریسک‌ها | `operations:risk-assessment` (با علی) |
| RACI نقش‌ها و SOPها (مثلاً بازبینی گواهی، پذیرش فروشنده) | `operations:process-doc` |
| داشبورد شاخص‌های جریان کار | `data:build-dashboard`، `dataviz` |
| بدهی فنی در پایان هر فاز | `engineering:tech-debt` (با علی) |

## ۳. طراحی محصول و تجربهٔ کاربری

| کار | skill | نقش |
|---|---|---|
| برنامهٔ مصاحبه با فروشنده/مشتری در بریزبین | `design:user-research` | جعفر (product-designer) |
| جمع‌بندی نتایج مصاحبه و بازخورد | `design:research-synthesis`، `product-management:synthesize-research` | جعفر، هادی |
| نقد طرح‌ها | `design:design-critique` | رضا (ui-ux-designer)، جعفر |
| سیستم طراحی و توکن‌ها | `design:design-system` | رضا |
| تحویل طرح به توسعه | `design:design-handoff` | رضا → مهدی |
| دسترس‌پذیری (WCAG 2.1 AA) | `design:accessibility-review` | رضا، ساجد |
| متن رابط، پیام خطا، **متن نشان‌های حلال و افشا (ADR-0012)** | `design:ux-copy` | رضا، جعفر (تأیید نهایی حقوقی) |

## ۴. مهندسی، کیفیت و امنیت

| کار | skill | نقش |
|---|---|---|
| استراتژی و برنامهٔ تست هر ماژول | `engineering:testing-strategy` | ساجد (qa-engineer) |
| مرور کد قبل از merge | `engineering:code-review` | علی، حسن (security-tester)، باقر |
| رفع باگ ساختاریافته | `engineering:debug` | حسین، مهدی |
| مستندات فنی، README، API | `engineering:documentation` | حسین، کاظم |
| چک‌لیست قبل از استقرار/انتشار | `engineering:deploy-checklist` | کاظم (devops)، باقر (QC) |
| Runbook عملیاتی (فاز ۷) | `operations:runbook` | کاظم |
| رسیدگی به رخداد بعد از راه‌اندازی | `engineering:incident-response` | کاظم، علی |
| انطباق قانونی (Privacy Act، ACL، GST، PCI، تأیید مرجع حلال) | `operations:compliance-tracking` | حسن، علی |

## ۵. داده و پایگاه داده

| کار | skill | نقش |
|---|---|---|
| کوئری‌های پیچیده، گزارش‌ها، بهینه‌سازی | `data:sql-queries`، `data:write-query` | مجتبی (database-designer) |
| بررسی داده‌های نمونه/seed و کیفیت داده | `data:explore-data`، `data:validate-data` | مجتبی، ساجد |
| شاخص‌های کسب‌وکار بعد از راه‌اندازی | `product-management:metrics-review`، `data:analyze` | هادی، جواد |
| نمودار و داشبورد | `dataviz`، `data:create-viz`، `data:build-dashboard` | جواد، هادی |

## ۶. خروجی فایل برای صاحب پروژه

| وقتی صاحب پروژه این را بخواهد | skill |
|---|---|
| سند Word (مثلاً بستهٔ مرور حقوقی برای وکیل یا مرجع حلال) | `anthropic-skills:docx` |
| PDF | `anthropic-skills:pdf` |
| جدول Excel (مثلاً فهرست کدپستی‌های Greater Brisbane، seed دسته‌ها) | `anthropic-skills:xlsx` |
| ارائه (مثلاً برای سرمایه‌گذار) | `anthropic-skills:pptx` |
| ساخت یا بهبود skill اختصاصی پروژه | `anthropic-skills:skill-creator` |

## ۷. skillهای اختصاصی پیشنهادی پروژه

این‌ها به‌صورت پیشنهاد به صاحب پروژه ارائه شده‌اند و بعد از ذخیره در اکانت، در این جدول وضعیت‌شان «فعال» می‌شود:

| skill | کاربرد | وضعیت |
|---|---|---|
| `mondapac-repo-doc-change` | روش امن تغییر مستندات ریپو (شاخه/worktree، حفظ CRLF، هویت commit، Conventional Commits، `Claude outputs`، شمارهٔ ADR، به‌روزرسانی وضعیت در Project) | پیشنهاد شده |
| `mondapac-module-gate` | اجرای دروازه‌های G1/G2 طبق ADR-0013 از برگه تا ثبت تأیید | پیشنهاد شده |
| `mondapac-role-review` | بازبینی موازی یک پیشنهاد توسط نقش‌های تیم و جمع‌بندی برای صاحب پروژه | پیشنهاد شده |
