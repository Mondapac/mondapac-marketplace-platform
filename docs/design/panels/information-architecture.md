# Admin and seller panels: information architecture and screen inventory

| | |
|---|---|
| Status | Draft for review (design track) |
| Date | 2026-10-07 |
| Authors | Jafar (product-designer), Reza (ui-ux-designer) |
| Reviewers | Hadi (product-owner), Mahdi (frontend-developer), Ali (cto), Hassan (security-tester), Sajad (qa-engineer) |
| Builds on | `docs/design/research/panels-ux-strategy.md` sections 5 and 6 (draft IA), `docs/design/frontend-kickoff.md` (approved look A with C's components), `docs/design/figma/README.md` (library 1.0), the G2 UX specs `docs/modules/identity/ux.md` and `docs/modules/sellers/ux.md`, and section 12 of every module brief |
| Preview | Design canvas "MondaPac Panel Shell" (https://claude.ai/artifact/TN1WZcJdeJ1zzBwZNRqwrZ), page "Panels · IA and key screens (2026-10-07)": S1, P3, B1–B3, the D16 mobile navigation and the sidebar. This is a review preview, not the Figma library; the Figma work follows section 6 and `docs/design/figma/update-procedure.md` (ADR-0017) |

## خلاصه برای صاحب پروژه

- **یک پوسته، دو پیکربندی.** هر دو پنل همان `AppShell`، `Sidebar` و `Topbar` را دارند. فرقشان فقط فهرست منو، شمارنده‌ها و مجوزهاست. این سند فهرست کامل منوی هر دو پنل را، با کلید مجوز و فاز هر آیتم، یک‌جا می‌آورد تا مهدی (توسعه‌دهندهٔ فرانت‌اند) منو را از یک فایل پیکربندی بسازد.
- **فهرست همهٔ صفحه‌ها.** صفحه‌ها و پنجره‌های دو پنل در ۵۵ ردیف آمده‌اند. ۲۶ ردیف مشخصات تأییدشدهٔ G2 دارند (هویت و فروشنده)، ۲ ردیف پیش‌نمایش‌های موجودند، ۱۴ ردیف منتظر G2 ماژول خودشان‌اند (گواهی، کاتالوگ، موجودی، قیمت) و ۱۳ ردیف مال فازهای بعدی‌اند. طبق ADR-0013 این دو گروه آخر هنوز طراحی جزئی نمی‌شوند.
- **نُه قالب صفحه** همهٔ این صفحه‌ها را می‌پوشانند؛ چهار تای آن‌ها در Figma هست و پنج تا (Auth، Form، Settings، Members/Roles، حالت‌های سیستمی) با نسخه‌های 1.1.0 تا 1.4.0 کتابخانه می‌آیند.
- **منوی موبایل (D16) تصمیم گرفته شد** (صاحب پروژه، ۲۰۲۶-۱۰-۰۷، گزینهٔ ۱): کشوی کناری با همان منو برای هر دو پنل، و برای فروشنده یک نوار پایین (خانه، سفارش‌ها، کاتالوگ، بیشتر). هادی (مالک محصول) نوار پایین را تأیید کرد. منوی آیکونی ۷۲ پیکسلی تبلت روی گوشی به کار نمی‌رود (بخش ۴.۱).

## 1. Rules this architecture follows

1. **One structure for both panels** (owner, 2026-10-01). Admin and Seller share `AppShell`, `Sidebar`, `Topbar` and the page templates of section 2; they differ only in the nav config, badge sources and permissions.
2. **The menu follows permissions** (owner: dynamic RBAC; ADR-0018). An item whose every permission the user lacks is not rendered. An action the user can see but not perform is shown disabled with its reason (identity criterion 9), never hidden and never a raw 403. The server is the boundary; the nav config only mirrors it.
3. **Work first.** Each panel opens on what needs action now (`panels-ux-strategy.md` principle 1). Observable: an admin's `/` shows the queue cards above any chart; an approved seller's `/` shows the setup guide until the shop is live, then Today; a seller who is not approved lands on S1.
4. **Market and time are explicit.** The Topbar always shows the Market chip; times show the owning party's zone (ADR-0005).
5. **Module gates hold** (ADR-0013). A screen is designed in detail only after its module's G2 (G1 for the screen list). Rows below for modules without G2 are placeholders for planning, not designs.
6. **Figma first** (ADR-0017). Every template and component named here is built in the Figma library before frontend code uses it.
7. **AI sits inside forms and pages,** never as a chat window in the panels (owner decision; ADR-0019). No AI element appears in an acting-as session. Observable: no panel route opens a chat panel or floating assistant.

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
| T9 | **System states** (no access, not found, empty, error; plus `Shared · Account security`) | Every panel route | — | 1.2.0 (`Shared · No access`, `EmptyState`) |

## 3. Navigation config

One config per panel, read by the shared `Sidebar`. Each item has an `id`, a label key, a route, an optional group, the permission keys that show it (any one is enough), an optional badge source, and the phase in which the item first appears. Items of a phase that has not shipped are absent from the build, not disabled.

Permission keys in `code` exist in an approved G2 design. "(module G2)" means the module's own G2 names the key; until then the item is not built.

### 3.1 Admin panel

| id | Label | Group | Route | Shown with any of | Badge | Phase | Features |
|---|---|---|---|---|---|---|---|
| `home` | Home | — | `/` | always | — | 2 | — |
| `queue` | Review queue | — | `/review` (tabs per queue type) | the decision key of at least one tab: `identity.seller-access.approve` (Seller applications), `sellers.identity-change.approve` (Business changes), certification, catalog and pricing decision keys (module G2). A view key alone does not show it | count of items awaiting a decision the user may take (attention tone) | 3 | SEL-03, CERT-11, CERT-41, CERT-47, CAT-32, CAT-51..53, VER-03, VER-04 |
| `sellers` | Sellers | Marketplace | `/sellers` | `identity.seller-access.view`, `sellers.seller.view` | sellers awaiting review (neutral) | 2 (P1), 3 (full) | SEL-03, SEL-06, SEL-07, SEL-14 |
| `catalogue` | Catalogue → Products, Categories, Attributes, Certification types and issuers, Claim basis policies | Marketplace | `/catalogue/...` | (catalog and certification G2) | — | 3 | CAT-01..03, CAT-40..48, CERT-01..04, CERT-42 |
| `orders` | Orders → Orders, Returns | Marketplace | `/orders`, `/returns` | (ordering G2; returns in phase 7) | — | 5 | ORD-03, ORD-04, RET-05, RET-06 |
| `customers` | Customers | Marketplace | `/customers` | `identity.customer-account.view` | — | Later, no phase assigned (needs the identity ux 1.3 mini-review before the first real customer) | CUS-01..03 |
| `finance` | Finance → Payouts, Transactions, Commission | Money | `/finance/...` | (payments, commission-payouts G2) | payouts ready | 5 | PAY-03..08, COM-01, COM-02, VER-09 |
| `content` | Content | Platform | `/content` | (content G2) | — | 6 | STO-12, STO-14, VER-12 |
| `settings` | Settings → Market, Sellers, Service areas, Legal documents | Platform | `/settings/...` | `sellers.market-settings.view`; others at their module's gate | — | 3 | INTL-01, SEL-15, CAT-36, VER-11 |
| `team` | Roles & permissions (tabs Admins, Roles) | Platform | `/team`, `/team/roles`, `/team/roles/:roleId` | `identity.admin-account.view`, `identity.platform-role.view` | open invitations | 2 | ADM-05 |
| `audit` | Audit log | Platform | `/audit` | (key named when the screen exists) | — | data from phase 2 (IMP-10); the screen in phase 7 is this track's proposal for Hadi (VER-08) | IMP-10, VER-08 |
| `help` | Help & resources (footer, fixed place: WCAG 3.2.6) | — | external help page | always | — | 2 | — |

The user menu in the Topbar holds Account security (`/account/security`, B4) and Sign out.

**Review queue.** One inbox with a tab per queue type. Each tab appears only when the user holds that queue's decision key: Seller applications and Business changes (sellers G2), Certificates and Issuer requests (certification G2), Product revisions and Category proposals (catalog G2), Price holds (pricing G2). The same items stay reachable from their own section with a status filter (`panels-ux-strategy.md` 6.2).

### 3.2 Seller panel

| id | Label | Group | Route | Shown with any of | Badge | Phase | Features |
|---|---|---|---|---|---|---|---|
| `s_home` | Home (setup guide until the shop is live, then Today) | — | `/` | always (approved seller) | — | 3 | PNL-01 |
| `s_orders` | Orders → Order board, All orders | — | `/orders/board`, `/orders` | (ordering G2) | orders needing action (attention) | 5 | ORD-01..07, SHP-01..05 |
| `s_returns` | Returns | — | `/returns` | (returns, phase 7) | — | 7 | RET-03..07 |
| `s_catalogue` | Catalogue → Products and offers, Add a product, Import, Stock locations | Shop | `/catalogue/...` | (catalog, inventory, pricing G2) | — | 3–4 | OFR-01..18, INV-01..07, CAT-16 |
| `s_certs` | Certifications | Shop | `/certifications` | (certification G2) | expiring or needing changes (attention) | 3 | CERT-10..17, CERT-47 |
| `s_messages` | Messages | Shop | `/messages` | (phase 6) | unread (neutral) | 6 | MSG-01, MSG-02 |
| `s_money` | Payouts | Money | `/payouts` | (payments G2) | — | 5 | PAY-01, PAY-02, PAY-06, PAY-09 |
| `s_performance` | Performance | Account | `/performance` | (HLT, phase 7) | — | 7 | HLT-01..04 |
| `s_store` | Store profile (including the Settings card with minimum order) | Account | `/store` | `sellers.store-profile.view` | pending change | 3 | PNL-02, SEL-24 |
| `s_team` | Team & roles (tabs Team, Roles) | Account | `/team`, `/team/roles`, `/team/roles/:roleId` | `identity.team-member.view`, `identity.seller-role.view` | open invitations | 2 (identity slice 11) | PNL-05 |
| `s_settings` | Settings → Notifications, Payout account | Account | `/settings/...` | (notifications and payments G2) | — | 5–6 | PNL-03, VER-10 |
| `help` | Help & resources | — | external | always | — | 2 | — |

The shop switch at the top of the sidebar appears only when an account belongs to more than one shop (not in Phase 2 or 3; one membership per account, identity DD 2.1).

### 3.3 Limited seller shell (not approved yet)

A seller who is not approved signs in to a limited shell (identity decisions 6 and 9). Its items come only from the server allow-list (identity DD 5.2): in Phase 2 that is **Your seller account** (`s_setup`, route `/account-setup`, S1 with the steps S2 to S6 from `sellers`), Account security and Sign out, plus Help. **Certifications** is added only when the certification G2 adds its use case to the allow-list. Any other route goes to S1, not B5 (identity DD 8.5). The Topbar hides search and notifications (`Topbar` booleans, library 1.1.0) and makes no badge call. Below 760 px it uses the compact header with no drawer and no bottom bar (identity ux F5). Store profile, Team and every other item appear on approval.

**Acting-as (Login as Seller, SEL-08)** is not in Phase 2 or 3 scope. Its shell is defined by the SEL-08 mini-review; until then it has no nav config. When it comes: a permanent banner naming the admin, read-only identity, team and payout items (sellers DD 6.4), and AI switched off on the server (`actingAs` in `ActorContext`, ADR-0019 R3), not only hidden in the UI.

### 3.4 Topbar

Breadcrumb (panel name, then page); global search with Ctrl/Cmd+K (hidden in the limited shell); Market chip (`AU · AUD · Brisbane AEST`, from Market configuration, board request 6); notifications; user menu (name, role, Account security, Sign out). Admin and seller topbars differ only in the search hint and the user's role line.

## 4. Breakpoints and mobile navigation (D16, decided)

D16 was the open "mobile drawer navigation" item of `docs/design/figma/README.md` section 14 and `claude/design-status.md`; identity ux sections 6 and 8.2 and sellers ux sections 1.3 and 4 listed it as blocking phone layouts. It is not one of D1 to D7 in `panels-ux-strategy.md` section 8.

| Width | Sidebar | Topbar | Notes |
|---|---|---|---|
| 1280 px and up | Expanded, 248 px (`size-sidebar`) | Full | Desktop admin work |
| 760–1279 px | Collapsed to 72 px icons (`size-sidebar-collapsed`); expands as an overlay on demand | Search becomes an icon button | Seller tablet; the order board keeps its own touch layout (T4) |
| Below 760 px | Hidden; the same config opens as a **drawer** from the inline-start edge | 56 px: menu button, panel mark, notifications, account | Phone |

Decision (owner, 2026-10-07, option 1; Hadi confirmed the bottom bar):
- **Both panels: drawer.** The drawer renders the same nav config as the desktop sidebar, same groups and order, so nothing is phone-only. While open, the background is `inert` and the drawer is `aria-modal`; focus is trapped; Esc, the scrim and any navigation close it; focus returns to the menu button. It renders only the already-filtered config. Targets are 48 px (`data-density="touch"`, `--mp-size-control`).
- **Seller only: a bottom bar** with four tabs (Home, Orders, Catalogue, More). "More" opens the drawer. Reason: a shop owner or staff member on a phone switches between orders and stock many times an hour (V1 and V2 in `panels-ux-strategy.md` 2.2); one thumb tap beats opening a drawer each time. Admin work on a phone is occasional, so admin keeps the drawer only.
- The bottom bar is shown only when the user may see at least two of Home, Orders and Catalogue; it then shows those items plus More, which is always present. Otherwise only the drawer is used.

The owner chose the drawer for both panels plus the seller bottom bar on 2026-10-07. The bottom bar is new scope beyond `panels-ux-strategy.md` 6.1 (drawer only); Hadi confirmed it the same day. Library impact: new components `NavDrawer` and `BottomTabBar` (touch density), token `size/bottom-bar` (64 px), template frames at 360 px; released as library 1.5.0 (2026-10-07), ahead of the reserved 1.1.0–1.4.0.

### 4.1 The tablet rail on phones (team review, 2026-10-07)

The owner asked whether the 72 px icon rail of 760–1279 px should also serve phones. Team verdict (Reza, Jafar, Hadi, Mahdi): **no rail below 760 px**, neither instead of nor beside the drawer and bottom bar.
- Content width: a 72 px rail takes 20% of a 360 px screen and leaves about 256 px after padding, so tables and order cards scroll sideways at once.
- Labels: icon-only items are hard to recognise, and a 72 px rail cannot hold readable labels; touch has no hover tooltip.
- Two persistent navs: rail plus bottom bar would duplicate Home, Orders and Catalogue and add a third mode below 760 px.
- RTL: the mirrored rail sits on the thumb edge and meets the system back-swipe.
- Cost (Mahdi): about one extra day plus a rework of the 360 px frames, for no gain.

Phone landscape (for example 844×390) is wider than 760 px and so already gets the tablet rail; the bottom bar never appears there. Below 760 px in landscape the portrait rules apply. Reza's alternative (a height-based rule that swaps the bar for the rail on short screens) is kept as a later option if usage data shows sellers work in landscape.

Edge cases the frontend and the Figma frames must cover:
1. The limited seller shell has no drawer and no bottom bar (section 3.3).
2. Tabs come from the already-filtered nav config: a missing permission means fewer tabs, never a disabled tab. Before Orders ships (phase 5) the bar shows Home, Catalogue and More only if both Home and Catalogue are visible; otherwise only the drawer.
3. Every tab has a visible label, a target of at least 48 px and respects the bottom safe area.
4. The Orders badge caps at "9+" and follows the badge rule of section 7.
5. The bar hides while the on-screen keyboard is open.
6. More opens the same drawer; while the drawer is open More shows as active, and on a route that is not one of the tabs More is the active tab.
7. The acting-as banner, when SEL-08 adds it, is visible in every shell state, drawer open included, and sits above the bar, never under it. No AI entry point appears in the shell during acting-as (ADR-0019 R3).
8. Test the boundary at 759 px (drawer, bar) and 760 px (rail, no bar).

Three items were left open for Reza when library 1.5.0 shipped; all are decided (2026-10-07) and released as library 1.6.0:
- Scrim: token `bg/scrim` (`--mp-color-bg-scrim`), `#111827` at 50% in light and black at 60% in dark. The alpha is part of the value, so the drawer scrim frame uses the token at 100%.
- Menu icon: a new `menu` icon (three lines) for the phone topbar menu button; `panel-left` stays for the NavItem collapse.
- Topbar height: token `size/topbar-phone` (`--mp-size-topbar-phone`, 56 px) and a `PhoneTopbar` component (Admin and Seller) used by the three phone templates. The menu button is `aria-label` "Open menu" with `aria-expanded`, `aria-controls` and `aria-haspopup="dialog"`; the bell reads "Notifications, N unread" and the account button "Account". Focus order is menu, notifications, account. RTL mirrors the layer order and not the icons. The limited seller shell omits the menu-button slot. The acting-as banner sits below the topbar, not inside it, above the scrim and drawer.

## 5. Screen inventory

Status values: **G2** = approved detailed spec exists (ID refers to that spec); **G1** = the module brief lists the screen, design waits for the module's G2; **Later** = the module has no G1 yet.

### 5.1 Before sign-in (template T5, both panels)

| Screen | Panel | Spec | Status | Library |
|---|---|---|---|---|
| Sign in | Admin, Seller | identity A1 | G2 | 1.1.0 |
| Sign up | Seller | identity A2 | G2 | 1.1.0 |
| Check your email; Confirm your email | Admin, Seller | identity A3, A4 | G2 | 1.1.0 |
| Forgot password; Choose a new password | Admin, Seller | identity A5, A6 | G2 | 1.1.0 |
| Two-step: enter code; set up | Admin, Seller | identity A7, A8 | G2 | 1.1.0 |
| Two-step: confirm the reset an admin started | Seller | identity A11 | G2 | 1.1.0 |
| Accept invitation (admin, seller created by an admin, team member) | Admin, Seller | identity A9 | G2 | 1.1.0 |
| Account suspended | Seller | identity A10 | G2 | 1.1.0 |

### 5.2 Admin panel

| Screen | Route | Template | Module | Spec | Status | Library |
|---|---|---|---|---|---|---|---|
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
| Account security | `/account/security` | `Shared · Account security` (identity ux 4) | identity | identity B4 | G2 | 1.2.0 |
| No access / not found | any | T9 | identity | identity B5 | G2 | 1.2.0 |
| Certificate queue; Issuer requests | `/review?type=…` | T2 | certification | brief 12 | G1 | — |
| Certificate review | `/certificates/:id/review` | T3 | certification | brief 12; `F_AdminReview` preview must be updated to R2 | G1 | — |
| Certification types; Issuer registry | `/catalogue/certification-types`, `/catalogue/issuers` | T2, T6 | certification | brief 12 | G1 | — |
| Manufacturer certificates; Claim basis policies | `/catalogue/manufacturer-certificates`, `/catalogue/claim-policies` | T2, T6 | certification | brief 12 | G1 | — |
| Product review queue; Revision review | `/review?type=revision`, `/revisions/:id` | T2, T3 | catalog | brief 12 | G1 | — |
| Platform products | `/catalogue/products` | T2, T6 | catalog | brief 12 | G1 | — |
| Category tree; Attributes; Category proposals | `/catalogue/categories`, `/catalogue/attributes` | tree editor (new), T6 | catalog | brief 12 | G1 | — |
| Price hold queue | `/review?type=price-hold` | T2, T3 | pricing | brief 12; G2 design in draft PR #44 | G1 | — |
| Orders; Order detail | `/orders` | T2, T3 | ordering | — | Later | — |
| Returns and refunds | `/returns` | T2, T3 | returns | — | Later | — |
| Payouts; Transactions; Commission | `/finance/...` | T2, T7 | payments, commission-payouts | — | Later | — |
| Customers | `/customers` | T2 | identity | identity ux 1.3: not designed, mini-review needed | Later | — |
| Market settings; Service areas; Legal documents | `/settings/...` | T7 | platform, legal | ADR-0026 pending | Later | — |
| Content | `/content` | — | content | — | Later | — |
| Audit log | `/audit` | T2 | platform | — | Later | — |

### 5.3 Seller panel

| Screen | Route | Template | Module | Spec | Status | Library |
|---|---|---|---|---|---|---|---|
| Your seller account (limited shell) | `/account-setup` | T6 | identity, sellers | identity S1; sellers S1 | G2 | 1.1.0, 1.3.0 |
| Business details; Address and area; Business number and tax; Shop web address; Review and submit | `/account-setup/...` | T6 | sellers | sellers S2–S6 | G2 | 1.3.0 |
| Store profile (with the Settings card: minimum order) | `/store` | T6 | sellers | sellers S7, 3.1a; sellers DD 18 | G2 | 1.4.0 |
| Confirm it's you | dialog | — | sellers | sellers D9 | G2 (needs identity R-2) | 1.4.0 |
| Team; Roles; Role editor | `/team...` | T8 | identity | identity B1, B2, B3 | G2 | 1.2.0 |
| Invite a team member; Change role | dialogs | — | identity | identity D1, D2 | G2 | 1.2.0 |
| Account security | `/account/security` | `Shared · Account security` (identity ux 4) | identity | identity B4 | G2 | 1.2.0 |
| No access / not found | any | T9 | identity | identity B5 | G2 | 1.2.0 |
| Home: setup guide, then Today | `/` | T1 | platform | `F_SellerHome` preview | Preview (content per module) | 1.0 |
| Certifications; Certificate form; Certificate detail | `/certifications...` | T2, T6, T3 | certification | brief 12 | G1 | — |
| Products and offers; Add a product; Product and offer form; Photos | `/catalogue...` | T2, T6 | catalog | brief 12 | G1 | — |
| Import | `/catalogue/import` | stepper (new) | catalog | brief 12 | G1 | — |
| Price, special price and cost (inside the offer form); price hold status | `/catalogue/offers/:id` | T6 | pricing | brief 12; G2 design in draft PR #44 | G1 | — |
| Stock and stock locations; low-stock threshold | `/catalogue/stock`, `/settings/stock-locations` | T2, T7 | inventory | brief 12; G2 design in draft PR #43 | G1 | — |
| Order board; All orders; Order detail | `/orders...` | T4, T2, T3 | ordering, shipping | `F_SellerBoard`, `F_SellerOrders` previews | Later | 1.0 |
| Returns | `/returns` | T2, T3 | returns | — | Later | — |
| Payouts and statements | `/payouts` | T2 | payments | — | Later | — |
| Messages | `/messages` | — | messaging | — | Later | — |
| Performance | `/performance` | T1 | health | — | Later | — |
| Notifications settings | `/settings/notifications` | T7 | notifications | — | Later | — |

**Count.** 55 rows across the auth pages and both panels (a row can hold several screens or dialogs of one spec): 26 rows have an approved G2 spec (identity and sellers), 2 are existing previews, 14 wait for their module's G2, and 13 belong to later phases or have no phase yet. Emails are text templates outside Figma and are not counted.

## 6. Order of design work

1. **Library 1.1.0 "Auth" and 1.2.0 "Panel"** (identity ux 8.1): unblock every Phase 2 frontend slice.
2. **Library 1.3.0 "Seller setup" and 1.4.0 "Seller admin"** (sellers ux 8.1).
3. **Nav release:** `NavDrawer`, `BottomTabBar` and the phone templates were released as 1.5.0 (D16, 2026-10-07). Still to come after 1.4.0: the nav config of section 3 as `Sidebar` variants (admin, seller full, seller limited) and the Review queue tab set.
4. **Module screens** after each G2: certification and catalog (Phase 3), then inventory, pricing and cart seller parts (Phase 4).
5. Each release follows `docs/design/figma/update-procedure.md`: sandbox, review, publish, Audit with zero warnings, token export, changelog, `claude/design-status.md`.

## 7. Hand-off to the frontend track

- Build the sidebar from a typed nav config per panel (`id`, label key, route, group, `anyOf` permission keys, badge source, children), filtered by the caller's effective permission keys that the server returns for the session. No `if (role === …)` in components. The sidebar, drawer and bottom bar all render this one filtered config. Filtering is presentation only: every route and API call still authorizes in the application layer (ADR-0018).
- Badge counts come from one lightweight endpoint per panel. The server filters them with the same permission check as the queue; a source the caller may not open is left out, not sent as 0. Counts are scoped to the caller's Market, and to their seller id in the seller panel. The limited shell makes no badge call.
- Routes in section 5 are paths within each panel's own host (Hassan 7: each panel on its own host); D2's ADR decides the app topology. Each panel host ships only its own nav config and route bundle: the admin config never appears in the seller build.
- An unknown route and another seller's or Market's record land on B5 "not found", byte-identical. A route the user has no view key for lands on B5 "no access". No session goes to A1, with a return URL only if it is a path of the same panel (identity F2 step 7). The limited shell sends other routes to S1.

**Acceptance checks for the nav (frontend tests):**
1. For every item with named keys: shown with any one of them, absent with none (one test per key).
2. Items of an unshipped phase are absent from the build, not disabled.
3. A disabled action shows its reason text (identity criterion 9).
4. Badge: no count for a source the user cannot open; no badge call in the limited shell.
5. B5 bodies for "not found" are byte-identical across unknown id, other seller and other Market.
6. Drawer: focus trapped, Esc, scrim and navigation close it, focus returns to the menu button, background inert.
7. Items whose keys say "(module G2)" are untestable until that G2 names the key; they are not built before then.
8. Bottom bar: the edge cases of section 4.1 (tabs from the filtered config, 759/760 px boundary, keyboard hides the bar, More active state).

## 8. Open points

| # | Point | Owner |
|---|---|---|
| 1 | ~~D16~~ Decided 2026-10-07: drawer for both panels plus the seller bottom bar; no rail on phones (section 4.1) | Closed |
| 2 | Which certification, catalog and pricing decision keys open each Review queue tab | Each module's G2 |
| 3 | `F_AdminReview` (certificate review preview) predates ADR-0019 R2 and must drop "automatic checks" that an AI could tick before it becomes a template | certification G2, Reza |
| 4 | Customers screen needs the "find and deactivate a customer" mini-review before the first real customer (identity ux 1.3), and a phase | Hadi |
| 5 | Audit log screen in phase 7 (VER-08) is this track's proposal; the data exists from phase 2 (IMP-10) | Hadi |
