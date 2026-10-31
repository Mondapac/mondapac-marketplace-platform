# ADR-0040: Seller Business Activities

**Status:** Accepted — 2026-10-31, on the project owner's decisions in the Figma page-design thread
(12:45Z to 12:58Z: one main activity plus extra activities, level 1–2 category branches, a server
rule with per-seller exceptions, per-activity review checks).
**Extends:** ADR-0010 (catalog scope: PLATFORM and SELLER content, all selling through Offers) and
the catalog category tree (CAT-40).
**Relates to:** SEL-12 "allowed product types" (a different, technical restriction that stays),
ADR-0012 and `evaluateClaim` (certification is independent and unchanged), ADR-0018 (access rules
in the application layer).

## Context
A seller's reach into the catalog was limited only by technical product types (SEL-12). The owner
wants every seller to carry a business activity (Grocery, Butcher, ...) so that its category picker
and its search of platform products only show what belongs to that activity.

## Decision
1. **Activities are data owned by `catalog`.** An admin defines them per Market at Catalog ›
   Business activities (`catalog.business_activities`, with `business_activity_names` per locale
   and `business_activity_categories`). A code is fixed at creation; the name in the Market's
   default locale is required, other supported locales are optional; a short description and an
   Active/Inactive status complete the record. Names are never machine-translated.
2. **Scope is a set of category branches.** An activity links level 1 or 2 categories of the
   platform tree; descendants inherit. A linked category must be live when it is linked; a later
   archive or merge is followed by the scope resolution (a later package), never by deleting rows.
3. **No certification wording.** A name or description that asserts a certification is refused
   through the claim-term matcher; an unavailable matcher refuses (fail closed). Activities are
   not certification tags and never feed `evaluateClaim`.
4. **Sellers carry activities (later packages).** One main and optional extra activities, chosen at
   sign-up or in Add seller and approved in review; a change by the seller is a change request, a
   direct admin change needs a reason. `sellers` owns that assignment and `catalog` reads the
   resulting scope through a contract; no cross-module table join.
5. **Server-side enforcement (later packages).** Offers, imports and category proposals outside the
   seller's scope are refused by the server, with per-seller category exceptions an admin can add.
   A seller with no activity cannot create offers (fail closed). Removing a branch from an activity
   takes affected offers off sale (never deletes them) and shows the impact first. An activity is
   deleted only while no seller uses it, otherwise it is made inactive.
6. **Permissions.** `catalog.business-activity.read` and `catalog.business-activity.edit` are
   platform keys, unprotected (a definition moves no money, certification or access by itself);
   the Platform Administrator holds them. The access rule on offers that uses the scope is reviewed
   by security-tester when it is built.

## Consequences
- This package (1 of 4) adds the tables, the admin API and the permission keys, and changes no
  seller or offer behaviour. Nothing reads activities yet, so it is safe to merge before the panel.
- The admin page, the seller assignment and the offer rule follow as separate packages.
