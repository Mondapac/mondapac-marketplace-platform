# بررسی آمادگی برای فاز ۲ (هویت و کاربران) — 2026-10-01

بررسی روی `main` (کامیت `8167647`) در محیط ساخت انجام شد: Linux، Node 24.21، pnpm 10.28،
PostgreSQL 16. روی Windows و GitHub چیزی اجرا نشده است.

## ۱. تست دستورها

همهٔ دستورها فقط با فایل `.env` (کپی `.env.example`) و بدون متغیر محیطی اضافه اجرا شدند.

| دستور | نتیجه |
|---|---|
| `pnpm install --frozen-lockfile` | موفق؛ روی Node 22 با پیام روشن رد می‌شود |
| `pnpm db:migrate` | موفق |
| `pnpm typecheck` / `pnpm lint` / `pnpm boundaries` / `pnpm format` | موفق |
| `pnpm test` | ۶۴ تست موفق |
| `pnpm test:db` | ۱۶ تست موفق |
| `pnpm db:check-reversible` | موفق |
| `pnpm verify` | موفق |
| `pnpm build`، `pnpm dev`، `pnpm start` | موفق؛ `/health/ready` پاسخ 200 |
| `pnpm db:migrate:dev` | موفق، ولی اشکال ۲ را داشت |
| `docker compose up -d` | **اجرا نشد** (این محیط به Docker Hub دسترسی ندارد)؛ اشکال ۱ با بررسی رجیستری پیدا شد |

یک برش آزمایشی شبیه فاز ۲ هم ساخته و بعد حذف شد: مدل Prisma در schema جدا، مهاجرت با
`down.sql`، repository در `infrastructure/`، controller و تست دیتابیس برای دو بازار.
کل زنجیره (`pnpm verify` و `pnpm build`) با آن سبز شد.

## ۲. اشکال‌های پیداشده و رفع‌شده (شاخهٔ `fix/phase-2-readiness`)

1. **`docker compose up -d` بالا نمی‌آمد.** image `minio/minio` دیگر در Docker Hub وجود
   ندارد. سرویس MinIO از `docker-compose.yml` حذف شد، چون هنوز هیچ کدی از ذخیره‌سازی فایل
   استفاده نمی‌کند. انتخاب جایگزین به اولین برشی که فایل ذخیره می‌کند (فاز ۳) موکول شد:
   ADR-0016 (وضعیت: Proposed، منتظر تأیید مالک پروژه).
2. **بعد از `pnpm db:migrate:dev` کلاینت Prisma قدیمی می‌ماند** و typecheck بعدی خطا
   می‌داد. حالا این دستور کلاینت را هم بازتولید می‌کند و `pnpm verify` و `pnpm build` هم
   اول کلاینت را بازتولید می‌کنند.
3. **`pnpm audit` دو هشدار high و یک moderate داشت** (در وابستگی‌های غیرمستقیم ابزار
   Prisma CLI، نه کد اجرایی). با `overrides` در `pnpm-workspace.yaml` رفع شد و حالا
   هشداری گزارش نمی‌شود.
4. مستندات (`README.md`، `CLAUDE.md`، `.env.example`، ADRهای 0004، 0006 و 0015) با این
   تغییرها هماهنگ شد؛ راهنمای Windows برای `cp` به README اضافه شد.

## ۳. آنچه هنوز تأیید نشده

- اجرای واقعی `docker compose up -d` (سه سرویس باقی‌مانده؛ وجود هر سه image در Docker Hub
  بررسی شد).
- اجرای workflow در GitHub Actions.
- `pnpm verify` و `pnpm dev` روی Windows. (`pnpm install` روی دستگاه مالک پروژه انجام شده
  است: پوشهٔ `node_modules` و کلاینت Prisma آنجا وجود دارد.)

## ۴. پیش‌نیازهای شروع فاز ۲

ابزار و اسکلت برای فاز ۲ آماده است. آنچه مانده از جنس تصمیم و طراحی است، نه اشکال کد:

| پیش‌نیاز | مرجع | مسئول |
|---|---|---|
| بستن فاز ۱: CI سبز، اجرای compose و verify روی دستگاه مالک، ارزیابی پایان فاز، تکرار QC | `docs/modules/README.md` | مالک پروژه، Javad، Bagher |
| تأیید ADR-0015 و ADR-0016 | ADRها | مالک پروژه |
| برگهٔ ماژول identity و دروازهٔ G1 | ADR-0013 | Hadi، مالک پروژه، Ali |
| ADR ساخت یا خرید برای Identity | مورد باز فاز ۰ | Ali، Mohammad |
| طراحی «platform foundations» (Id، Clock، MarketContext، Result، DomainEvent) | ADR-0015 | Mohammad، تأیید Ali |
| طراحی G2 برای identity، شامل وابستگی‌های جدید (argon2، rate limit) | ADR-0013 | Mohammad، Mojtaba، Hassan |
| market context در سطح درخواست، قبل از اولین endpoint غیرپلتفرمی | ADR-0015 | Mohammad، Hossein |
| نویسندهٔ audit، زنجیرهٔ هش و جداسازی نقش‌های دیتابیس، قبل از اولین ردیف audit | ADR-0015 تصمیم ۱ و ۲ | Hossein، Mojtaba، Kazem، Hassan |
| سخت‌سازی HTTP قبل از اولین endpoint احرازشده؛ تصمیم دربارهٔ `helmet` | ADR-0015 | مالک پروژه، Hossein |
| ثبت لاگ قبل از body parser، قبل از اولین endpoint با body | `docs/reviews/phase-1.md` | Hossein |
