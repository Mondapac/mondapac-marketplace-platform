# نقشهٔ استفاده از Skillها در پروژه

**تصمیم صاحب پروژه (۲۰۲۶-۱۰-۰۱):** در همهٔ مراحل و بخش‌های پروژه، skillهای مرتبطِ نصب‌شده در اکانت Claude استفاده شوند؛ هر جا skill لازم نبود یا کم بود، پیشنهاد skill جدید داده شود.

**قاعدهٔ اجرا:** قبل از شروع هر کار، جلسهٔ اصلی (ارکستریتور) در این جدول نگاه می‌کند و skill مرتبط را **پیش از** نوشتن خروجی بارگذاری می‌کند. skillها روش کار و قالب خروجی را می‌دهند؛ قوانین پروژه (CLAUDE.md، ADRها، دروازه‌های ADR-0013) همیشه بر آن‌ها مقدم‌اند. اگر skill با یک ADR تعارض داشت، ADR ملاک است و تعارض به علی (cto) گزارش می‌شود.

**شروع و پایان هر session (تصمیم صاحب پروژه ۲۰۲۶-۱۰-۰۲):** هر session، در هر مسیر کاری، در شروع و پایان کار skill پروژه `mondapac-track-session` را بارگذاری می‌کند (`docs/process/parallel-tracks.md`).

> **نکته دربارهٔ محیط — skillها کجا فعال‌اند:**
> - **skillهای اکانت** (engineering، product-management، design، data، operations و…) در جلسه‌های Cowork/claude.ai همین اکانت فعال‌اند و Claude آن‌ها را هنگام کار بارگذاری می‌کند.
> - **skillهای اختصاصی پروژه** در `.claude/skills/` داخل ریپو هستند؛ Claude Code (روی هر سیستمی که این ریپو را باز کند) آن‌ها را خودکار می‌بیند. این skillها اگر در اکانت هم ذخیره شوند، در Cowork هم در دسترس‌اند.
> - در Claude Code، skillهای اکانت خودبه‌خود حاضر نیستند مگر جداگانه نصب شوند؛ در آن صورت این جدول راهنمای روش کار است.
> - skillها ابزار **ساختن** پلتفرم‌اند (تحلیل، طراحی، مستندسازی، بازبینی، تست)، نه بخشی از نرم‌افزار در حال اجرای مارکت‌پلیس.
> - عامل‌های تیم (`.claude/agents/`) هم دستور دارند اگر ابزار Skill در دسترس بود، skillهای نقش خود را از همین جدول بارگذاری کنند.

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
| به‌روزرسانی سیستم طراحی Figma با هر صفحه، امکان یا کامپوننت تازه (ADR-0017) | `design:design-system` + skill اکانت `mondapac-design-system-update` (روال: `docs/design/figma/update-procedure.md`) | رضا، جعفر → مهدی |
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

تأییدشده توسط صاحب پروژه (۲۰۲۶-۱۰-۰۱). در ریپو زیر `.claude/skills/<name>/SKILL.md` قرار دارند؛ ذخیرهٔ آن‌ها در اکانت (از کارت پیشنهاد) آن‌ها را در Cowork هم فعال می‌کند:

| skill | کاربرد | وضعیت |
|---|---|---|
| `mondapac-repo-doc-change` | روش امن تغییر مستندات ریپو (شاخه/worktree، حفظ CRLF، هویت commit، Conventional Commits، `Claude outputs`، شمارهٔ ADR، به‌روزرسانی وضعیت در Project) | فعال در ریپو (`.claude/skills/`)؛ اکانت: منتظر ذخیره |
| `mondapac-module-gate` | اجرای دروازه‌های G1/G2 طبق ADR-0013 از برگه تا ثبت تأیید | فعال در ریپو (`.claude/skills/`)؛ اکانت: منتظر ذخیره |
| `mondapac-role-review` | بازبینی موازی یک پیشنهاد توسط نقش‌های تیم و جمع‌بندی برای صاحب پروژه | فعال در ریپو (`.claude/skills/`)؛ اکانت: منتظر ذخیره |
| `mondapac-track-session` | شروع و پایان هر session در مسیرهای کاری موازی: خواندن تابلوی `claude/tracks.md`، ماندن در محدودهٔ مسیر، فایل‌های مشترک، رزرو شمارهٔ ADR، به‌روزرسانی تابلو (تصمیم صاحب پروژه ۲۰۲۶-۱۰-۰۲) | فعال در ریپو (`.claude/skills/`)؛ اکانت: منتظر ذخیره |
