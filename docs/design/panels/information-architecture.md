# Admin and seller panels: information architecture and screen inventory

| | |
|---|---|
| Status | Draft for review (design track) |
| Date | 2026-10-07 |
| Authors | Jafar (product-designer), Reza (ui-ux-designer) |
| Reviewers | Hadi (product-owner), Mahdi (frontend-developer), Ali (cto), Hassan (security-tester), Sajad (qa-engineer) |
| Builds on | `docs/design/research/panels-ux-strategy.md` sections 5 and 6 (draft IA), `docs/design/frontend-kickoff.md` (approved look A with C's components), `docs/design/figma/README.md` (library 1.0), the G2 UX specs `docs/modules/identity/ux.md` and `docs/modules/sellers/ux.md`, and section 12 of every module brief |
| Preview | Canvas "MondaPac Panel Shell", page **"Panels · IA and key screens (2026-10-07)"** |

## خلاصه برای صاحب پروژه

- **یک پوسته، دو پیکربندی.** هر دو پنل همان `AppShell`، `Sidebar` و `Topbar` را دارند. فرقشان فقط فهرست منو، شمارنده‌ها و مجوزهاست. این سند فهرست کامل منوی هر دو پنل را، با کلید مجوز و فاز هر آیتم، یک‌جا می‌آورد تا مهدی (توسعه‌دهندهٔ فرانت‌اند) منو را از یک فایل پیکربندی بسازد.
- **فهرست همهٔ صفحه‌ها.** صفحه‌ها و پنجره‌های دو پنل در ۵۵ ردیف آمده‌اند. ۲۶ ردیف مشخصات تأییدشدهٔ G2 دارند (هویت و فروشنده)، ۲ ردیف پیش‌نمایش‌های موجودند، ۱۵ ردیف منتظر G2 ماژول خودشان‌اند (گواهی، کاتالوگ، موجودی، قیمت) و ۱۲ ردیف مال فازهای بعدی‌اند. طبق ADR-0013 این دو گروه آخر هنوز طراحی جزئی نمی‌شوند.
- **نُه قالب صفحه** همهٔ این صفحه‌ها را می‌پوشانند؛ پنج تای آن‌ها در Figma هست و چهار تا (Auth، Form، Settings، Members/Roles) با نسخه‌های 1.1.0 تا 1.4.0 کتابخانه می‌آیند.
- **منوی موبایل (D16)** که جلوی چند صفحهٔ فرانت را گرفته بود، اینجا پیشنهاد شده است: کشوی کناری با همان منو برای هر دو پنل، و برای فروشنده یک نوار پایین چهارتایی. این تنها تصمیمی است که از شما خواسته می‌شود.

## 1. Rules this architecture follows

1. **One structure for both panels** (owner, 2026-10-01). Admin and Seller share `AppShell`, `Sidebar`, `Topbar` and the page templates of section 2; they differ only in the nav config, badge sources and permissions.
2. **The menu follows permissions** (owner: dynamic RBAC; ADR-0018). An item whose every permission the user lacks is not rendered. An action the user can see but not perform is shown disabled with its reason (identity criterion 9), never hidden and never a raw 403. The server is the boundary; the nav config only mirrors it.
3. **Work first.** Each panel opens on what needs action now (`panels-ux-strategy.md` principle 1): the admin Review queue and the seller's Today or setup guide.
4. **Market and time are explicit.** The Topbar always shows the Market chip; times show the owning party's zone (ADR-0005).
5. **Module gates hold** (ADR-0013). A screen is designed in detail only after its module's G2 (G1 for the screen list). Rows below for modules without G2 are placeholders for planning, not designs.
6. **Figma first** (ADR-0017). Every template and component named here is built in the Figma library before frontend code uses it.
7. **AI sits inside forms and pages,** never as a chat window in the panels (owner decision; ADR-0019). No AI element appears in an acting-as session.

## 2. Page templates

Every screen in section 5 uses one of these. "In Figma" means a template page already exists in library 1.0.

| # | Template | Used for | Figma | Library release |
|---|---|---|---|---|
| T1 | **Home** (work queue first, then trends) | Admin Home, Seller Home (Today) | `Admin · Home`, `Seller · Home` | 1.0 |
| T2 | **Index** (search, filter chips, saved views, table, bulk bar) | Every list: sellers, products, offers, orders, payouts, queues | `Admin · Sellers`, `Seller · Orders` | 1.0 |
| T3 | **Detail / Review** (summary bar, 2/3 main + 1/3 side, timeline, decisions) | Seller review, certificate review, revision review, order detail | `Admin · Certificate review` | 1.0; `Admin · Seller review` in 1.4.0 |
| T4 | **Board** (touch density, columns by urgency) | Seller order board on a tablet | `Seller · Order board` | 1.0 |
| T5 | **Auth** (no shell; phone first) | Sign in, sign up, reset, two-step, invitations | — | 1.1.0 |
| T6 | **Setup step / Form** (grouped cards, `FormActionBar`, error summary) | Seller setup steps, store profile, product and offer forms, admin edit | — | 1.3.0 (`Seller · Setup step`), 1.4.0 (`Seller · Store profile`) |
| T7 | **Settings** (two-column sections of `SettingRow`) | Market settings, seller settings, notifications | — | 1.4.0 (`Shared · Settings`) |
| T8 | **Members and roles** (tabs Members, Roles; role editor) | Admin "Roles & permissions", Seller "Team & roles" | — | 1.2.0 (`Shared · Members`, `Shared · Roles`, `Shared · Role editor`) |
| T9 | **System states** (no access, not found, empty, error) | Every panel route | — | 1.2.0 (`Shared · No access`, `EmptyState`) |

## 3. Navigation config

One config per panel, read by the shared `Sidebar`. Each item has an `id`, a label key, a route, an optional group, the permission keys that show it (any one is enough), an optional badge source, and the phase in which the item first appears. Items of a phase that has not shipped are absent from the build, not disabled.

Permission keys in `code` exist in an approved G2 design. "(module G2)" means the module's own G2 names the key; until then the item is not built.

### 3.1 Admin panel

| id | Label | Group | Route | Shown with any of | Badge | Phase |
|---|---|---|---|---|---|---|
| `home` | Home | — | `/` | always | — | 2 |
| `queue` | Review queue | — | `/review` (tabs per queue type) | `identity.seller-access.view`, `sellers.seller-file.review`, certification and catalog review keys (module G2) | count of items awaiting a decision the user may take (attention tone) | 3 |
| `sellers` | Sellers | Marketplace | `/sellers` | `identity.seller-access.view`, `sellers.seller.view` | sellers awaiting review (neutral) | 2 (P1), 3 (full) |
| `catalogue` | Catalogue → Products, Categories, Attributes, Certification types and issuers, Claim basis policies | Marketplace | `/catalogue/...` | (catalog and certification G2) | — | 3 |
| `orders` | Orders → Orders, Returns | Marketplace | `/orders`, `/returns` | (ordering G2; returns in phase 7) | — | 5 |
| `customers` | Customers | Marketplace | `/customers` | `identity.customer-account.view` | — | before the first real customer (identity ux 1.3) |
| `finance` | Finance → Payouts, Transactions, Commission | Money | `/finance/...` | (payments, commission-payouts G2) | payouts ready | 5 |
| `content` | Content | Platform | `/content` | (content G2) | — | before launch |
| `settings` | Settings → Market, Sellers, Service areas, Legal documents | Platform | `/settings/...` | `sellers.market-settings.view`; others at their module's gate | — | 3 |
| `team` | Roles & permissions (tabs Admins, Roles) | Platform | `/team`, `/team/roles`, `/team/roles/:roleId` | `identity.admin-account.view`, `identity.platform-role.view` | open invitations | 2 |
| `audit` | Audit log | Platform | `/audit` | (key named when the screen exists; IMP-10, VER-08) | — | 7 |
| `help` | Help & resources (footer, fixed place: WCAG 3.2.6) | — | external help page | always | — | 2 |

The user menu in the Topbar holds Account security (`/account/security`, B4) and Sign out.

**Review queue.** One inbox with a tab per queue type. Each tab appears only when the user holds that queue's decision key: Seller applications and Business changes (sellers G2), Certificates and Issuer requests (certification G2), Product revisions and Category proposals (catalog G2), Price holds (pricing G2). The same items stay reachable from their own section with a status filter (`panels-ux-strategy.md` 6.2).

### 3.2 Seller panel

| id | Label | Group | Route | Shown with any of | Badge | Phase |
|---|---|---|---|---|---|---|
| `s_home` | Home (setup guide until the shop is live, then Today) | — | `/` | always (approved seller) | — | 3 |
| `s_orders` | Orders → Order board, All orders | — | `/orders/board`, `/orders` | (ordering G2) | orders needing action (attention) | 5 |
| `s_returns` | Returns | — | `/returns` | (returns, phase 7) | — | 7 |
| `s_catalogue` | Catalogue → Products and offers, Add a product, Import, Stock locations | Shop | `/catalogue/...` | (catalog, inventory, pricing G2) | — | 3–4 |
| `s_certs` | Certifications | Shop | `/certifications` | (certification G2) | expiring or needing changes (attention) | 3 |
| `s_messages` | Messages | Shop | `/messages` | (phase 6) | unread (neutral) | 6 |
| `s_money` | Payouts | Money | `/payouts` | (payments G2) | — | 5 |
| `s_performance` | Performance | Account | `/performance` | (HLT, phase 7) | — | 7 |
| `s_store` | Store profile | Account | `/store` | `sellers.store-profile.view` | pending change | 3 |
| `s_team` | Team & roles (tabs Team, Roles) | Account | `/team`, `/team/roles`, `/team/roles/:roleId` | `identity.team-member.view`, `identity.seller-role.view` | open invitations | 2 |
| `s_settings` | Settings → Shop settings, Notifications, Payout account | Account | `/settings/...` | `sellers.store-settings.edit` (shop settings); others at their gate | — | 3 |
| `help` | Help & resources | — | external | always | — | 2 |

The shop switch at the top of the sidebar appears only when an account belongs to more than one shop (not in Phase 2 or 3; one membership per account, identity DD 2.1).

### 3.3 Limited seller shell (not approved yet)

A seller who is not approved signs in to a limited shell (identity decisions 6 and 9): the sidebar shows only **Your seller account** (`s_setup`, route `/account-setup`, S1 with its steps S2 to S6) and **Certifications** (its step), plus Help. The Topbar hides search and notifications (`Topbar` booleans, library 1.1.0). Store profile, Team and every other item appear on approval. An acting-as (Login as Seller) session gets the full seller shell with a permanent banner and no AI elements (ADR-0019 R3).

### 3.4 Topbar

Breadcrumb (panel name, then page); global search with Ctrl/Cmd+K (hidden in the limited shell); Market chip (`AU · AUD · Brisbane AEST`, from Market configuration, board request 6); notifications; user menu (name, role, Account security, Sign out). Admin and seller topbars differ only in the search hint and the user's role line.

## 4. Breakpoints and mobile navigation (proposal for D16)

| Width | Sidebar | Topbar | Notes |
|---|---|---|---|
| 1280 px and up | Expanded, 248 px (`size-sidebar`) | Full | Desktop admin work |
| 768–1279 px | Collapsed to 72 px icons (`size-sidebar-collapsed`); expands as an overlay on demand | Search becomes an icon button | Seller tablet; the order board keeps its own touch layout (T4) |
| Below 768 px | Hidden; the same config opens as a **drawer** from the inline-start edge | 56 px: menu button, panel mark, notifications, account | Phone |

Proposal:
- **Both panels: drawer.** The drawer renders the same nav config as the desktop sidebar, same groups and order, so nothing is phone-only. Focus is trapped while open; Esc and the scrim close it; focus returns to the menu button. Targets are at least 44 px (touch density).
- **Seller only: a bottom bar** with four tabs (Home, Orders, Catalogue, More). "More" opens the drawer. Reason: a shop owner or staff member on a phone switches between orders and stock many times an hour (V1 and V2 in `panels-ux-strategy.md` 2.2); one thumb tap beats opening a drawer each time. Admin work on a phone is occasional, so admin keeps the drawer only.
- The bottom bar shows only items the user may see; with fewer than three visible items it is not shown and the drawer is used alone.

This is the only owner decision in this document: drawer for both panels, with or without the seller bottom bar. Library impact: new components `NavDrawer` and `BottomTabBar` (touch density), token `size/bottom-bar` (64 px), template frames at 360 px; a MINOR release after 1.4.0.

## 5. Screen inventory

Status values: **G2** = approved detailed spec exists (ID refers to that spec); **G1** = the module brief lists the screen, design waits for the module's G2; **Later** = the module has no G1 yet.

### 5.1 Before sign-in (template T5, both panels)

| Screen | Panel | Spec | Status | Library |
|---|---|---|---|---|
| Sign in | Admin, Seller | identity A1 | G2 | 1.1.0 |
| Sign up | Seller | identity A2 | G2 | 1.1.0 |
| Check your email; Confirm your email | Admin, Seller | identity A3, A4 | G2 | 1.1.0 |
| Forgot password; Choose a new password | Admin, Seller | identity A5, A6 | G2 | 1.1.0 |
| Two-step: enter code; set up; confirm reset | Admin, Seller | identity A7, A8, A11 | G2 | 1.1.0 |
| Accept invitation (admin, seller created by an admin, team member) | Admin, Seller | identity A9 | G2 | 1.1.0 |
| Account suspended | Seller | identity A10 | G2 | 1.1.0 |

### 5.2 Admin panel

| Screen | Route | Template | Module | Spec | Status | Library |
|---|---|---|---|---|---|---|
| Home | `/` | T1 | platform | `F_AdminHome` preview | Preview (content per module) | 1.0 |
| Review queue | `/review` | T2 | several | this doc 3.1 | G1 (queue tabs land with each module's G2) | after 1.4.0 |
| Sellers | `/sellers` | T2 | identity, sellers | identity P1; sellers P1 | G2 | 1.2.0, 1.4.0 |
| Seller page (+ History tab, admin-only card C1) | `/sellers/:id` | T3 | sellers | sellers P2, P2-H, C1 | G2 | 1.4.0 |
| Review a submission | `/sellers/:id/review` | T3 | sellers | sellers P3 | G2 | 1.4.0 |
| Add seller; Reject; Suspend; Confirm | dialogs | — | identity | identity D3–D6 | G2 | 1.2.0 |
| Change web address; Correct time zone; Bulk result | dialogs | — | sellers | sellers D7, D8, D10 | G2 | 1.4.0 |
| Seller settings (Market) | `/settings/sellers` | T7 | sellers | sellers P4 | G2 | 1.4.0 |
| Admins; Roles; Role editor | `/team...` | T8 | identity | identity B1, B2, B3 | G2 | 1.2.0 |
| Invite an admin; Change role | dialogs | — | identity | identity D1, D2 | G2 | 1.2.0 |
| Account security | `/account/security` | T6 | identity | identity B4 | G2 | 1.2.0 |
| No access / not found | any | T9 | identity | identity B5 | G2 | 1.2.0 |
| Certificate queue; Issuer requests | `/review?type=…` | T2 | certification | brief 12 | G1 | — |
| Certificate review | `/certificates/:id/review` | T3 | certification | brief 12; `F_AdminReview` preview must be updated to R2 | G1 | — |
| Certification types; Issuer registry | `/catalogue/certification-types`, `/catalogue/issuers` | T2, T6 | certification | brief 12 | G1 | — |
| Manufacturer certificates; Claim basis policies | `/catalogue/manufacturer-certificates`, `/catalogue/claim-policies` | T2, T6 | certification | brief 12 | G1 | — |
| Product review queue; Revision review | `/review?type=revision`, `/revisions/:id` | T2, T3 | catalog | brief 12 | G1 | — |
| Platform products | `/catalogue/products` | T2, T6 | catalog | brief 12 | G1 | — |
| Category tree; Attributes; Category proposals | `/catalogue/categories`, `/catalogue/attributes` | tree editor (new), T6 | catalog | brief 12 | G1 | — |
| Price hold queue | `/review?type=price-hold` | T2, T3 | pricing | brief 12; Phase 4 design draft | G1 (G2 draft in review) | — |
| Orders; Order detail | `/orders` | T2, T3 | ordering | — | Later | — |
| Returns and refunds | `/returns` | T2, T3 | returns | — | Later | — |
| Payouts; Transactions; Commission | `/finance/...` | T2, T7 | payments, commission-payouts | — | Later | — |
| Customers | `/customers` | T2 | identity | identity ux 1.3 (mini-review needed) | G1 | — |
| Market settings; Service areas; Legal documents | `/settings/...` | T7 | platform, legal | ADR-0026 pending | Later | — |
| Content | `/content` | — | content | — | Later | — |
| Audit log | `/audit` | T2 | platform | — | Later | — |

### 5.3 Seller panel

| Screen | Route | Template | Module | Spec | Status | Library |
|---|---|---|---|---|---|---|
| Your seller account (limited shell) | `/account-setup` | T6 | identity, sellers | identity S1; sellers S1 | G2 | 1.1.0, 1.3.0 |
| Business details; Address and area; Business number and tax; Shop web address; Review and submit | `/account-setup/...` | T6 | sellers | sellers S2–S6 | G2 | 1.3.0 |
| Store profile | `/store` | T6 | sellers | sellers S7 | G2 | 1.4.0 |
| Confirm it's you | dialog | — | sellers | sellers D9 | G2 (needs identity R-2) | 1.4.0 |
| Team; Roles; Role editor | `/team...` | T8 | identity | identity B1, B2, B3 | G2 | 1.2.0 |
| Invite a team member; Change role | dialogs | — | identity | identity D1, D2 | G2 | 1.2.0 |
| Account security | `/account/security` | T6 | identity | identity B4 | G2 | 1.2.0 |
| No access / not found | any | T9 | identity | identity B5 | G2 | 1.2.0 |
| Home: setup guide, then Today | `/` | T1 | platform | `F_SellerHome` preview | Preview (content per module) | 1.0 |
| Certifications; Certificate form; Certificate detail | `/certifications...` | T2, T6, T3 | certification | brief 12 | G1 | — |
| Products and offers; Add a product; Product and offer form; Photos | `/catalogue...` | T2, T6 | catalog | brief 12 | G1 | — |
| Import | `/catalogue/import` | stepper (new) | catalog | brief 12 | G1 | — |
| Price, special price and cost (inside the offer form); price hold status | `/catalogue/offers/:id` | T6 | pricing | Phase 4 design draft | G1 (G2 draft in review) | — |
| Stock and stock locations; low-stock threshold | `/catalogue/stock`, `/settings/stock-locations` | T2, T7 | inventory | Phase 4 design draft | G1 (G2 draft in review) | — |
| Minimum order (Shop settings) | `/settings/shop` | T7 | sellers, cart | sellers 18 | G2 (mini-review merged) | 1.4.0 |
| Order board; All orders; Order detail | `/orders...` | T4, T2, T3 | ordering, shipping | `F_SellerBoard`, `F_SellerOrders` previews | Later | 1.0 |
| Returns | `/returns` | T2, T3 | returns | — | Later | — |
| Payouts and statements | `/payouts` | T2 | payments | — | Later | — |
| Messages | `/messages` | — | messaging | — | Later | — |
| Performance | `/performance` | T1 | health | — | Later | — |
| Notifications settings | `/settings/notifications` | T7 | notifications | — | Later | — |

**Count.** 55 rows across the auth pages and both panels (a row can hold several screens or dialogs of one spec): 26 rows have an approved G2 spec (identity and sellers), 2 are existing previews, 15 wait for their module's G2, and 12 belong to later phases. Emails are text templates outside Figma and are not counted.

## 6. Order of design work

1. **Library 1.1.0 "Auth" and 1.2.0 "Panel"** (identity ux 8.1): unblock every Phase 2 frontend slice.
2. **Library 1.3.0 "Seller setup" and 1.4.0 "Seller admin"** (sellers ux 8.1).
3. **Nav release (after 1.4.0):** the nav config of section 3 as `Sidebar` variants (admin, seller full, seller limited), `NavDrawer`, `BottomTabBar` once D16 is decided, and the Review queue tab set.
4. **Module screens** after each G2: certification and catalog (Phase 3), then inventory, pricing and cart seller parts (Phase 4).
5. Each release follows `docs/design/figma/update-procedure.md`: sandbox, review, publish, Audit with zero warnings, token export, changelog, `claude/design-status.md`.

## 7. Hand-off to the frontend track

- Build the sidebar from a typed nav config per panel (`id`, label key, route, group, `anyOf` permission keys, badge source, children), filtered by the caller's effective permission keys from the session. No `if (role === …)` in components.
- Badge counts come from one lightweight endpoint per panel; a badge never reveals a count for a queue the user cannot open.
- Routes in section 5 are paths within each panel's own host (Hassan 7: each panel on its own host); D2's ADR decides the app topology.
- Unknown route, missing permission, and another seller's or Market's record all land on B5, byte-identical for "not found" (identity B5).

## 8. Open points

| # | Point | Owner |
|---|---|---|
| 1 | D16: drawer for both panels, with or without the seller bottom bar (section 4) | Owner |
| 2 | Which certification, catalog and pricing decision keys open each Review queue tab | Each module's G2 |
| 3 | `F_AdminReview` (certificate review preview) predates ADR-0019 R2 and must drop "automatic checks" that an AI could tick before it becomes a template | certification G2, Reza |
| 4 | Customers screen needs the "find and deactivate a customer" mini-review before the first real customer (identity ux 1.3) | Hadi |
