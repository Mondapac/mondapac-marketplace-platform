# ADR-0053: AI Model Choice in the Admin Panel

**Status:** Accepted — 2026-11-25 (owner decision Q3 in the AI Gateway design, version 3: a section
«AI Models» with two tabs, several external models ranked per task type; only a senior admin
changes gateway settings, with in-place TOTP confirmation; build approved with «ساخت» on
2026-11-25). Drafted by Mohammad (software-architect); Ali (cto) and Hassan (security-tester)
review the G0 PR.
**Supersedes:** ADR-0026 decision 9 and ADR-0042 decision 7, for "AI provider, model and region"
only; everything else on their "never a setting" lists stays
**Amends:** ADR-0019 R7 ("provider, model and processing region are Market configuration": they now
come from the route catalogue of ADR-0052 plus an admin choice among its approved rows) and ADR-0019
decision 2 (a chat window in the seller panel only, owner decision Q2; decision 7 below)
**Relates to:** ADR-0052, ADR-0019 decisions 7 and 9, ADR-0018 decision 4, ADR-0042 decisions 1
and 2, `docs/design/domain/platform-ai.md` section 8

## Context
ADR-0026 decision 9 and ADR-0042 decision 7 say the AI provider, model and region are never an
admin setting. The gateway design gives the admin panel a section «AI Models» where a senior admin
adds external models, ranks them per task type (chat, extract, write, vision), marks a saver model,
and later sets the rollout stage of the in-house model. Moving these values off the "never a
setting" list needs a superseding ADR and security-tester review (ADR-0026 decision 9).

## Decision
1. **What becomes a setting.** Per Market, in the `settings` store of ADR-0042, versioned and
   audited: the models in use (chosen from the ADR-0052 catalogue), the priority list of up to three
   models per task type, the saver model and saver threshold, an assistant's own priority list when
   it has one, the in-house model's stage per task type and its auto-rollback limits, the caps,
   guest share and alert thresholds, the shadow and percent share, and the emergency stop for the
   Market.
2. **What stays out of the panel.** API keys; the route catalogue and its prices (ADR-0052); the
   in-house endpoint address; safety rules, field allow-lists, masking, prompt text and evaluation
   sets; the server-wide `AI_KILL_SWITCH`; recording an evaluation as passed (a panel run yields a
   pass candidate only; the pass is recorded by PR).
3. **Server-side validation of every value.** A model enters a task type's list only if its
   catalogue row is usable under ADR-0052 decision 3 (key present, verified no-retention, region
   meets the Market's requirement, not retired) and it passed the evaluation of every capability of
   that task type in the Market. The saver model must be cheaper than model 1. The same checks
   apply to the saver model, an assistant's own list, a revert and the auto-rollback limits, which
   have a server ceiling and a minimum sample size. A stage of the in-house model other than off is
   accepted only if its route is usable and that version passed its evaluation, and the same holds
   for rolling back to a previous version; customer data reaches shadow only once the owner's
   written approval is recorded in ADR-0052. Save-time checks are not enough: at call time the
   router skips any model without a recorded pass for the calling capability, provider, model and
   current prompt version; with none left, the capability is off (R8).
4. **Who may change.** Keys `settings.ai-models.manage` and `settings.ai-gateway.manage` change,
   `settings.ai-gateway.view` reads (ADR-0042 decision 2). Only senior admins hold the manage keys
   (owner decision Q4): both are protected permission keys that only the Platform Administrator
   role may grant (identity brief R11), so a key in any other role is a deliberate, audited
   Platform Administrator decision; a permission contract test fails if any other seeded role
   holds them. An admin changes only their own Market.
5. **In-place TOTP confirmation**, through the existing admin step-up (registered action keys, as
   for the wallet admin settings; admins always have a second factor, ADR-0018 decision 5); never a
   second admin. Required for: adding or removing a model; a priority list, saver model or saver
   threshold; running an evaluation from the panel; loosening auto-rollback limits; the in-house
   stage or raising the shadow or percent share; raising a cap or the guest share; switching a capability on, or on again after an emergency
   stop; reverting to a previous version. Switching off never needs it.
6. **Revert is a forward change** that passes the same validation and confirmation.
7. **A chat window in the seller panel** (owner decision Q2, amends ADR-0019 decision 2). The seller
   panel may have a chat window (the seller assistant's side panel); the admin panel still has none,
   and an admin assistant needs a design of its own (FE-235). Every other rule of ADR-0019 applies
   to the seller chat unchanged, R3 and R9 in particular: tools only under the seller's own
   session, none in an acting-as session.

## Consequences
- ADR-0026 decision 9 and ADR-0042 decision 7 get a "Superseded in part by ADR-0053" note.
- The `settings` module gains AI definitions, controllers and three permission keys (G4); the gateway
  reads them through a port and imports no module.
- A wrong choice in the panel can raise cost or route traffic to a weaker approved model, but never
  to an unapproved route, price or region: those stay code.
- Several admin actions now need TOTP confirmation in place; a mistaken or stolen session alone
  cannot change routing, caps or the in-house stage.

## Alternatives considered
- **Keep model choice in configuration (environment variables):** every change of model or order
  needs a deploy and Kazem; the owner wants it in the panel.
- **Any admin with the settings permission:** the owner chose senior admins only.
- **A second admin's approval instead of TOTP:** slower, and the TOTP step-up already exists and is
  reviewed.
