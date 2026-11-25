# ADR-0051: Offer Review Policy as Admin-Editable Market Settings

**Status:** Proposed — 2026-11-25, on the project owner's decisions in the risk-based Offer approval
design (`design/catalog/offer-approval/offer-approval-design-fa.html`, 25 Nov 2026: risk-based
approach, 10 first Offers, 3 businesses for a reference price, ±50 % band, 5 % sampling, every
number editable in the admin panel). Hassan (security-tester) and Reza (ui-ux-designer) review the
implementation PR.
**Amends:** ADR-0042 (the store takes whole-number settings and a page may save several settings in
one write)
**Relates to:** ADR-0026 decisions 3 to 5, ADR-0024 (pricing owns the price hold), catalog brief
CAT-36

## Context
The owner chose risk-based Offer approval: an Offer on a platform product goes live when automatic
checks pass, and only risky Offers wait for an admin. The owner asked that every number of the rules
be changeable in the admin panel (Settings → Catalogue), not in code. ADR-0026 and ADR-0042 already
give one store with a version, history, audit row, review request and safe value per setting, but
every setting there is a choice from a fixed list, and each page saves one setting per request.
The Offer review page has six settings that belong together.

## Decision
1. **The policy is six settings in the shared store** (owner `settings`, read later by `catalog`
   and `pricing` through the settings facade):

   | Code | Values | Launch value | Safe value |
   |---|---|---|---|
   | `offer-review-mode` | `risk-based`, `all`, `off` | `risk-based` | `all` |
   | `offer-review-probation-offers` | whole number 0 to 100 | 10 | 100 |
   | `offer-review-reference-sellers` | whole number 2 to 20 | 3 | 20 |
   | `offer-review-price-band` (percent) | whole number 5 to 200 | 50 | 5 |
   | `offer-review-sampling` (percent) | whole number 0 to 100 | 5 | 100 |
   | `offer-review-certificate-badges` | `review`, `automatic` | `review` | `review` |

   Each safe value sends more Offers to a person, never fewer (ADR-0026 decision 5).
2. **Whole-number settings.** A definition may declare integer bounds instead of a value list. The
   value is stored as plain decimal text ("10"); "07", "1e1", "1.5" and values outside the bounds
   are refused. A change is audited by its own action, `settings.market-setting.number-changed`,
   whose before and after are integers, so no free text reaches the audit row.
3. **One page, one write, all or nothing.** `PUT settings/admin/offer-review` takes a list of
   changed settings, each with the version the admin saw. Every version is checked before anything
   is written; a stale one is a conflict and nothing is saved. Each change still gets its own
   history row, audit row and, where area `marketplace` is reviewed, its own review request, so a
   reviewer can reject one of them and its reverter restores that one alone.
4. **Keys.** `settings.offer-review.view` and `settings.offer-review.manage`, not protected; only
   the Platform Administrator holds the manage key until the owner gives it to a role. The
   emergency stop (R0), "Trusted from start" and "full review" are not settings here: they are
   separate use cases with their own keys, a required reason and an audit row (later slices).
5. **No behaviour change in this slice.** Nothing reads the settings yet; `catalog` reads them when
   the referral policy ships. Until then every first publication still waits as before.

## Consequences
- A whole-number setting costs a definition, its bounds and a translation, like a choice.
- The Offer review numbers change at run time without a release, with history and audit.
- A store that cannot be read falls back to "every Offer waits", which can grow the queue; the queue
  backlog alert (a later slice) makes that visible.

## Alternatives considered
- **Numbers in the Market file (`config/markets/`):** a release per change, which the owner refused.
- **One request per setting from the page:** a failure half way leaves some numbers saved and some
  not, with no way to tell the admin which.
- **A catalog-owned table:** a fifth copy of a store ADR-0042 decision 4 forbids.
