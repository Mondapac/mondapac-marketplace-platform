# Platform AI: the AI Gateway (`platform/ai`)

**Author:** Mohammad (software-architect), from the owner-approved design
`design/ai-gateway/ai-gateway-design-fa.html` (version 3, project files), 2026-11-25
**Status:** Accepted on the owner's decision («ساخت», 25 Nov 2026), with the decisions of section 13. Reviewed on the design by Mohammad (software-architect), Hassan (security-tester) and Mojtaba
(database-designer), all "accept with changes", applied. This file is the `platform/ai` design
document that ADR-0019 decision 6 asks for; it is built in PRs G1 to G7 (section 12).
**Ground truth:** ADR-0019 (R1 to R15, decisions 3, 6, 7, 9, 10, 12), ADR-0052 (providers,
routes and regions; "ADR 3"), ADR-0053 (model choice in the admin panel), ADR-0026, ADR-0042,
ADR-0008 decisions 2 and 6, ADR-0018 decision 4, ADR-0020 decision 2.
**Code on main checked:** `apps/api/src/platform/ai` (`ModelGateway.complete`, `ModelProvider`,
`AnthropicMessagesProvider`, no streaming), `AI_KILL_SWITCH`, the `ASSISTANT_MODEL_*` variables in
`platform/config/app-config.ts`, the assistant's `assistant.spend_days` and
`subject-message-limits.ts`, catalog's `description-writer-switches.ts`, the settings store
`settings/domain/definitions.ts` (main 26bde02).

## 1. Where we start

A first gateway exists: `ModelGateway` in `apps/api/src/platform/ai`. Only that folder calls a
model, and only files on the checked-in allow-list (`apps/api/.dependency-cruiser.cjs`) import it.

| Topic                          | Today                                                                                                                 | State   | Code                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------- |
| One model entry point          | Every call goes through `ModelGateway.complete`, with a timeout, never inside a UnitOfWork                            | Ready   | `model-gateway.ts`               |
| Provider-neutral shape         | Messages, tools, token usage and stop reason are our own types                                                        | Ready   | `model-provider.ts`              |
| Provider                       | One adapter for the Anthropic Messages API, no streaming (on purpose: the whole answer is checked before it is shown) | Partial | `anthropic-messages.provider.ts` |
| Model choice                   | Two tiers, `fast` and `balanced`; model id, key and price per Market from `ASSISTANT_MODEL_*`, read at boot only      | Partial | `app-config.ts`                  |
| Fallback                       | None: an error means "unavailable" and the host flow completes without AI                                             | Missing | `model-gateway.ts`               |
| Kill switch                    | `AI_KILL_SWITCH` turns everything off                                                                                 | Ready   | `model-gateway.ts`               |
| Capability and seller switches | Each module reads its own: the assistant from its settings, the description writer from `settings` and `sellers`      | Partial | `description-writer-switches.ts` |
| Spend cap                      | Only the buyer assistant (`assistant.spend_days`); the description writer counts drafts per day only                  | Partial | `prisma-spend.repository.ts`     |
| Request limits                 | Per guest and per customer in the buyer assistant, on a PostgreSQL counter                                            | Partial | `subject-message-limits.ts`      |
| Usage record per call          | Only an error log (Market, tier, failure kind); no latency, model or cost                                             | Missing | `model-gateway.ts`               |
| Admin settings                 | Switch and tier per capability; provider and model were never panel settings (until ADR-0053)                         | Partial | `settings/domain/definitions.ts` |

## 2. Consumers

| Consumer                               | State                                | Task types                                    | Special need                                                                          |
| -------------------------------------- | ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Buyer assistant (`assistant`)          | Stages 0 and 1 built                 | chat with READ tools, extract, later vision   | High volume, a separate guest pool, a multi-round tool loop (each round is one `run`) |
| Seller assistant (seller panel)        | Designed 25 Nov, waits for «ساخت»    | understand an instruction, match a price list | Cap per seller, per-seller switch (SEL-25), tools only under the seller's own session |
| Admin assistant                        | No design (FE-235, owner: "not now") | summary, draft text, report explanation       | No tools under an admin (R9); the page supplies the input                             |
| Description writer (`catalog`, AIS-03) | Built                                | write                                         | Joins the central caps and usage record                                               |

The seller panel gets a chat window (ADR-0019 decision 2 as amended on 2026-11-25); the admin
panel does not.

## 3. Scope

- **In:** capability registry, switch evaluation, spend caps and limits, routing and fallback, a
  second adapter, usage record and monitoring, the admin pages «AI Models» and «AI Gateway», and
  the slot for the in-house model (Mondapac Intelligence) with shadow mode.
- **Out:** building or hosting the in-house model, the training pipeline, training-data export,
  semantic search (it goes to the search ADR), word-by-word streaming, and the admin assistant
  itself.
- **Fixed rule (R8):** no main platform flow depends on AI. Off, slow or out of budget, the flow
  completes without AI.

## 4. Architecture

The gateway is not a separate service. It is `platform/ai` inside `apps/api` and imports no
module. Where it needs another module's data it declares a port that the module implements.

| Job                               | Where                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability definition             | The owning module, in `contracts/` | Each module registers its capabilities at boot (`assistant.buyer-chat`, `catalog.description-writer.seller`, `catalog.description-writer.admin`, ...; one capability per audience). A spec carries task type, audience, seller-scoped or not, input and output token caps, max tool rounds, timeout and prompt version. The gateway validates only; an unknown or duplicate capability fails boot.                                                               |
| Field allow-list and output guard | The owning module                  | The gateway receives a request the module already built, so it cannot know where a field came from; the claim rule needs `certification` data. A CI test with a fake provider (ADR-0019 decision 9) proves no field outside the allow-list leaves.                                                                                                                                                                                                               |
| Switches                          | Gateway                            | Evaluated in this order: kill switch, capability switch for the Market, and the seller's switch through the `sellers` port when the capability is seller-scoped. A seller-scoped capability called without a seller id is refused; the module takes the id from the seller `ActorContext` or the loaded aggregate, never from input. An unregistered capability is off at run time. An acting-as session ("Login as Seller") is always off. Any error means off. |
| Budget and limits                 | Gateway                            | Reserve before the call, settle after it (section 7).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Generic masking of personal data  | Gateway                            | Email, phone and card numbers are masked in every part of the request, tool results included. Second line of defence only: the field allow-list is the control that keeps address, phone and payment data out.                                                                                                                                                                                                                                                   |
| Router and adapters               | Gateway                            | Reads the task type's priority list and calls with a timeout (section 6).                                                                                                                                                                                                                                                                                                                                                                                        |
| Generic output check              | Gateway                            | Schema check, HTML and links made inert.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Usage record                      | Gateway                            | One row per call, never the text (section 10).                                                                                                                                                                                                                                                                                                                                                                                                                   |

```
module (contracts/: CapabilitySpec, field allow-list, guard)
   │  gateway.run(capability, context, request)
   ▼
platform/ai
   registry ─ switches (kill, Market, seller port) ─ budget reserve ─ masker
   ─ router (priority list, saver, breaker) ─ adapter (timeout) ─ output check
   ─ settle + usage row
```

## 5. API contract

**Internal contract.** Modules no longer send a model name, and (after the interim below) no
model tier; they name the capability. One `run` is one model round: the buyer assistant, which loops over tools, calls `run`
once per round. Cost comes back on success and failure, because a provider may bill a call that
ran out of time.

```ts
gateway.status(capability, context: CallContext,
               opts: { tier /* G1 to G4 only */, sellerId?, timeoutMs? })
  → { on: true } | { on: false, reason: 'kill-switch' | 'emergency-stop' | 'off' | 'no-route' | 'over-budget' }

gateway.run(capability, context: CallContext, request: ModelRequest,
            opts: { tier /* G1 to G4 only */, sellerId?, timeoutMs? })
  → { ok: true,  turn, route: { provider, model, attempt }, cost }
  | { ok: false, reason: 'off' | 'over-budget' | 'rate-limited' | 'unavailable'
                       | 'timeout' | 'rejected-output', cost }

CapabilitySpec = { id, audience: 'buyer' | 'seller' | 'admin' | 'system',
                   task: 'chat' | 'extract' | 'write' | 'vision', sellerScoped,
                   maxInputTokens, maxOutputTokens, maxToolRounds, timeoutMs, promptVersion }
```

**Interim (G1 to G4).** Until priority lists exist (G4), the owning module passes its capability's
configured model tier (`ai-description-writer-tier`, the assistant's tier setting) as `opts.tier`;
the usage row records the resolved model id. Likewise the Market's on/off switch of a capability
stays where it is today (the assistant's settings, the description writer's setting) and the module
checks it before `status`/`run`; the gateway evaluates the kill switch, the acting-as state, the
audience, the seller switch through the `sellers` port and the configured tier (the catalogue's
route conditions apply from G3). `status` takes the caller's `CallContext`, because the audience
and acting-as checks need the actor. `maxInputTokens` and `maxToolRounds` are declared and
validated from G1 and enforced by the gateway from G2; until then each module keeps its own caps.
From G2 `status` reads the budget in a read-only unit of its own and `run` writes it in short
units of its own, so neither is ever called inside a UnitOfWork (an open unit makes `status` answer
off); the assistant asks `status` after its settings unit. G4 moves both into the
`settings` definitions the gateway reads, and the `tier` option goes. `opts.timeoutMs` may only
shorten the capability's `timeoutMs`.

**Caps enforced from G2.** `maxInputTokens` is checked before any call against an estimate of two
characters a token (the reservation uses the larger bound of one token a character). A capability
with `maxToolRounds` > 0 allows that many `run`s per user turn: the caller passes `opts.turnId`, a
random id per user message, and a `run` without one is off; the count is kept in memory on the API
instance that serves the turn. A capability with `maxToolRounds` = 0 allows one run and is never
sent tools. A refused input, an exhausted turn and a full cap all answer `over-budget` and are
counted as refusals in `ai_usage_days`.

**Provider contract.** `ModelProvider` stays and gains two things: image input and the processing
region identifier. Word-by-word streaming is not in this design, because the output guard and the
claim rule must see the whole answer before it is shown; the buyer assistant's current streamed
reply is sent after that check.

**HTTP contract for the in-house model.** One endpoint in our message format. The answer returns
the model version id and token counts. No text is retained; processing is in the Market's region
(Sydney for AU). Authentication is a server-only key or mTLS. The contract is locked with a version
number so the partner team can work in parallel (G6).

## 6. Routing and fallback

- **Priority list per task type.** For each Market and task type (chat, extract, write, vision) an
  ordered list of up to 3 models, which the admin sets in the External models tab (section 8). The
  gateway tries model 1, then 2, then 3 when one is down or slow. An assistant may have its own
  list when needed.
- **Saver mode.** When the month's spend reaches a threshold (default 80 %), the gateway puts the
  "saver model" the admin marked first for that task type, so an assistant stays on up to 100 %
  instead of switching off.
- **When to move to the next model:** only on an outage, a timeout, a server error or a provider
  rate limit. Never on a refusal or an invalid output. The second attempt's cost is reserved before
  it is sent.
- **Circuit breaker.** A provider that fails several times in a row is set aside for a few minutes
  and requests go straight to the fallback; the monitoring page shows it.
- **Evaluation gate.** Per ADR-0019 decision 9, a pass is bound to provider, model and prompt
  version. The result is recorded in a file in the repository, which the router reads. A model that
  has not passed a capability's evaluation is neither its primary nor its fallback: save-time checks
  are not enough, so at call time the router skips any model without a recorded pass for that
  capability, provider, model and current prompt version. With no model left, or no valid fallback
  during an outage, the capability is off (R8).
- **Data gate.** A fallback must also meet ADR-0019 decision 3 (no retention, no training,
  processing in the Market's region). A model whose region is not recorded cannot be chosen.
- **Fallback route (owner decision, Q1).** The same model through a second hosting route in the
  Market's region (for AU, for example Amazon Bedrock in `ap-southeast-2`), so the evaluation and
  prompt stay the same. It covers an outage of the primary service, not a fault of the model
  itself. It is usable only once its catalogue row carries Hassan's verification (ADR-0052
  decision 2); the router reads only the row.
- **Shadow mode (in-house model).** A share of requests is also sent to the second model; its answer
  is never shown to anyone or stored. Only metrics are compared: tokens, latency, valid-output rate
  and guard-rejection rate. Shadow runs only for single-round capabilities without tools and its
  cost comes out of the same budget. Before the first shadow request the partner endpoint must meet
  ADR-0052 and Hassan approves it. Customer data goes to shadow only with the owner's written
  approval.

**Built in G3 (code in `apps/api/src/platform/ai/catalogue/`, `evaluations/`, `routing/`).**

- The route catalogue is one file per route (`anthropic.ts` for Anthropic's own API, `bedrock.ts` for
  Amazon Bedrock's Messages API endpoint in `ap-southeast-2`); a row holds the exact model id, the
  model family, the region, Hassan's no-retention and no-training check (`dataTerms`), the list
  price and the retirement day. No row carries a check yet (ADR-0052 verification log empty), and
  the Anthropic API rows have no region recorded, so no route is usable and every capability is off
  until Hassan records a row. Evaluation passes live in `evaluations/results.ts` (empty), bound to
  capability, provider, family and prompt version; a pass of a family holds on each of its routes.
  The one exception (an evaluation run may use a row without a pass) is a router subclass under
  `test/` only, so the API cannot build it.
- Region pinning (Hassan, G3 review): a Bedrock row's model id is the in-region id (`anthropic.…`)
  or Australia's profile (`au.anthropic.…`), never a cross-region profile (`global.`, `apac.` …).
  A checked-in Anthropic API row records no region until the adapter sends a region control. The
  adapter never follows a redirect.
- A task type without a Market list (G4b settings) uses, until G4d, the one family the module's tier names (`ASSISTANT_MODEL_FAST`
  or `_BALANCED`, now a catalogue family; a name outside the catalogue is logged as an error and
  that tier is off, the API still boots, R8). The router
  expands it to its usable rows, provider route first, at most 3 attempts. Market residency and the
  saver model were Market configuration `aiRouting` until G4b (the saver model is now a setting;
  the residency stays configuration until INTL-53).
- An attempt moves to the next route on a timeout, a server error, no answer, a rate limit, or a
  route that refuses its key or model (401, 403, 404); never on a request the provider cannot take
  (400, 413, 422: `rejected`) or a model refusal. Each attempt reserves before it is sent (call id =
  reservation id), at the dearest route of the plan, and is recorded with its attempt number; a call
  on a route after the plan's first (also when the breaker skipped the first) counts in
  `ai_usage_days.fallbacks`. Routes without a key, or set aside, are skipped before any budget is
  held. With a fallback that can be tried now, an attempt takes two thirds of the time left; a
  fallback needs 250 ms left of the run's timeout.
- The circuit breaker is per API instance, per Market and route: 3 route failures in a row (server
  error, no answer, rate limit, refused key or model; never a timeout, which may be one slow
  request) set the route aside for 2 minutes, then one trial call, taken right before it is sent
  (FE-20261125-ai-gateway-shared-breaker). When `status` says on but every route is set aside, `run`
  answers `unavailable`.
- Saver mode reads the Market's month counter (held, which includes spent) against its month cap;
  the saver model goes first only when it is usable and cheaper than the first model.
- The second adapter is the same Messages adapter with Bedrock's regional host and a Bedrock API key
  as a bearer token (`AI_BEDROCK_API_KEY`). The provider-reported region check is deferred
  (FE-20261125-ai-gateway-region-check); Bedrock prices are first-party list prices until Kazem
  records Bedrock's (FE-20261125-ai-gateway-bedrock-price).

## 7. Cost and limits

- **Unit.** Cost is recorded in US micro-dollars, because providers bill in dollars; the panel also
  shows an approximate amount in the Market's currency.
- **Caps.** Daily and monthly per Market, per capability, daily per seller, and a separate guest
  share so guest traffic cannot use the whole budget. Caps are hard: when one is full, the
  capability is off until the next day or month.
- **Reserve before the call.** The largest possible cost is reserved first, at the price of the most
  expensive model on the route, and settled with the real figure after the answer, so concurrent
  requests cannot pass the cap. Before the reservation the gateway reads the counters without a
  lock, so a call that cannot fit is refused before any Market row is locked. A reservation not
  settled (a server died, or the settle failed three times) has an expiry, and a scheduled job
  counts its whole estimate as spent: the call may have been billed, so a failure over-counts and
  never under-counts (Hassan, PR 1348 M2). A late settle then writes the call's row only.
- **Status.** `status` answers over-budget once a cap of the scope cannot take the most one call of
  the capability can cost (its largest input and its whole output allowance at the tier's price),
  so the host flow shows its non-AI path instead of an answer that fails (Hassan, PR 1348 M1).
- **Cost guards.** Each capability has an input token cap, an output token cap and a max tool-round
  count. Guest-id creation is limited per IP.
- **Alerts.** At 80 % of a cap the admin is notified. At 100 % the capability switches off and at
  most one more notice is sent per day. (Deferred: FE-20261125-ai-gateway-budget-alerts; G2 counts
  and refuses only, and a full cap switches the capability off without a notice.)
- **Message limits** stay in the module: the gateway counts model rounds, not user messages.
- **Cap values (G4a).** The `settings` module's AI Gateway settings (ADR-0042 store, versioned,
  audited): `ai-cap-market-day`, `ai-cap-market-month`, `ai-cap-capability-day`, `ai-cap-seller-day`
  and `ai-cap-guest-day`, each `none` (the default: counted, not enforced) or whole US
  micro-dollars up to 10^12; 0 allows nothing. The gateway reads them with the emergency stop through
  the port `AiGatewayControls` (`platform/ai/gateway-controls.ts`, implemented by settings) once per
  `status` and `run`; a read that fails is off (R8), and a stored value the definition no longer
  allows is read as 0. The Market configuration's `aiBudget` section is removed; no real Market
  file had it (only the ZZ test fixture), so no cap is lifted and no data moves (ADR-0042 decision
  6), and a file that still has it fails at boot. The reader is a port read, not a use case: the
  gateway calls it for every actor it serves, the system actor of an asynchronous capability
  included, and no access rule kind of ADR-0018 decision 4 admits every actor (adding one amends
  that decision); it answers only the caller's Market and never leaves the server. The guest pool is
  the buyer capabilities' calls by anonymous visitors.
- **Moving the buyer assistant's cap.** G2 only counts in parallel and moves nothing.
  `assistant.spend_days` moves to the gateway in its own later PR, in steps (section 10).

## 8. Admin panel: «AI Models» and gateway settings

Under Settings › AI a section **AI Models** with two tabs, plus an **AI Gateway** page for caps and
monitoring. Per ADR-0042 the settings are defined in the `settings` module, with their permissions
and API there; the gateway reads them through a port. Choosing a model in the panel conflicts with
ADR-0026 decision 9 and ADR-0042 decision 7, so ADR-0053 supersedes those points.

**Tab 1: External models.**

- **Add model.** The admin picks a provider from the connected providers, then a model from that
  provider's allow-list. Model ids are never typed, because one key usually reaches several regions
  and preview versions. The allow-list is changed by PR and Hassan approves it with the connection;
  each row has the exact model version, region, no-retention status, input and output price and
  retirement date. Any id outside the list is refused on the server. When a provider returns the
  processing region, the gateway checks it too: a mismatch is a failed call, the route is set
  aside (circuit breaker) and a security alert goes to Kazem and Hassan.
- **Price.** From the price table in the repository, never from the panel: a price below reality
  would shrink the reservation and void the cap. Each month the gateway's total is compared with the
  provider's invoice and a mismatch raises an alert.
- **Evaluation.** A new model is "not evaluated". "Run evaluation" runs each capability's synthetic
  evaluation set on the real model in a background job. The estimated cost is shown first and
  confirmed with TOTP; the cost comes out of a small separate evaluation budget, not the assistants'
  caps. One run per model at a time; closed once spend reached the saver threshold. A panel result
  is only a "pass candidate", bound to provider, model, prompt version and evaluation-set version; it
  becomes "passed" when a small PR records it in the results file. A model enters a task type's
  list only if it passed the evaluation of every capability of that task type in the Market; the
  router still skips a model not passed for the calling capability (section 6). An evaluation or
  playground run may use a catalogue row that meets every other condition of ADR-0052 decision 3,
  with synthetic samples only.
- **Priority.** Per task type a list of up to 3 models plus one saver model. Each assistant uses
  these lists by default and may get its own. The same server checks apply to every list, to the
  saver model, to an assistant's own list, to a revert and to the auto-rollback limits. The saver
  model must be cheaper than model 1.
- **Scorecard.** Cost per 1000 requests, error rate, p95 latency, number of times the next model
  stood in, evaluation result; all from the last 30 days of `ai_usage_days`.
- **Playground.** The admin runs ready evaluation samples (no customer data) on two models side by
  side. The server accepts only a sample id; no free text from the browser reaches a model. Runs are
  limited per admin per day and paid from the evaluation budget. Answers are shown as plain text,
  never HTML.
- **Change preview.** Before saving: a summary of the changes and the estimated monthly cost change,
  from the last 30 days' usage.
- **Retirement alert.** The admin is notified 30 days before a model's retirement date; a retired
  model leaves the lists automatically.

**Tab 2: Mondapac Intelligence (in-house model).**

- **Stage per task type:** off, shadow (metrics only), percent, or default. In default the in-house
  model is first in the priority list and external models are its fallback.
- **Auto rollback.** In percent or default, if the error rate or guard-rejection rate passes the
  limit the admin set, the gateway returns to external models by itself and tells the admin. The
  server has a ceiling for these limits (for example 5 %) and a minimum sample size. Tightening a
  limit needs no confirmation; loosening one needs TOTP.
- **Roll back to the previous version:** one button, if that version passed its evaluation.
- **Conditions:** a stage other than off is accepted only if the in-house route is usable under
  ADR-0052 decision 3 and that version passed its evaluation; the same holds for "roll back to the
  previous version". The endpoint address changes only by PR. Customer data reaches shadow only
  once the owner's written approval is recorded in ADR-0052.

**AI Gateway page.** Tabs Overview (today's and this month's cost against the caps, requests,
errors, latency and fallbacks per capability), Limits (caps, guest share, alert and saver
thresholds) and Capabilities (state of each capability, linking to its own settings). The
emergency stop for all AI of a Market sits on top of this page. Switches that exist today (the
description writer's, the buyer assistant's) are not rebuilt.

| Set in the panel                                           | Not in the panel                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a model from the allow-list of the connected providers | The per-provider model allow-list and its price table (by PR). Connecting a new provider: Kazem puts the key in the server's secret manager and Hassan approves the no-retention contract and region; the panel only shows "connected". |
| Priority list per task type and saver model                | API keys                                                                                                                                                                                                                                |
| In-house model stage and auto-rollback limits              | The in-house endpoint address (by PR only)                                                                                                                                                                                              |
| Caps, guest share and thresholds                           | Safety rules, field allow-lists, masking, prompt text and evaluation sets                                                                                                                                                               |
| Emergency stop for one Market                              | The server-wide `AI_KILL_SWITCH` (Kazem only)                                                                                                                                                                                           |

- **Permissions:** `settings.ai-models.manage` and `settings.ai-gateway.manage` to change,
  `settings.ai-gateway.view` to see, named per ADR-0042. Each admin changes only their own Market.
  Only a senior admin is given the change permissions (owner decision, Q4): the two manage keys are
  protected permission keys that only the Platform Administrator role may grant (identity brief
  R11), so a key in any other role is a deliberate, audited Platform Administrator decision; a
  permission contract test fails if a seeded role other than it holds them.
- **In-place confirmation (owner decision).** The admin is not signed out: a small dialog asks for
  the six-digit TOTP code, through the existing admin step-up (registered action keys, as for the
  wallet admin settings; admins always have a second factor, ADR-0018 decision 5). These changes
  need it: adding or removing a model; changing a priority list, the saver model or the saver
  threshold; running an evaluation from the panel; loosening auto-rollback limits; changing the
  in-house stage or raising the shadow or percent share; raising a cap or the guest share;
  switching a capability on, or on again after an emergency stop; reverting settings
  to a previous version. Switching something off never needs confirmation.
- **Versions and revert.** Each change in the ADR-0042 store has a version and an audit row. A
  revert is a new forward change and passes the same server checks and confirmation.
- **Built in G4a (limits and emergency stop).** `GET settings/admin/ai-gateway` (key
  `settings.ai-gateway.view`), `PUT settings/admin/ai-gateway/limits` and `PUT
settings/admin/ai-gateway/emergency-stop` (protected key `settings.ai-gateway.manage`). Raising or
  lifting a cap spends the admin step-up `settings.ai-gateway-limits.raise` and switching the stop
  off spends `settings.ai-gateway-emergency-stop.resume`, in the change's own unit; lowering a cap or
  switching the stop on spends none (the route carries no `@RequiresStepUp`, the use case decides).
  The stop always needs a reason, kept on the setting's history row (`note`, migration
  `20261125220000_settings_history_note`) whether or not the area is reviewed; the audit row holds
  no free text (ADR-0009). Every change is reviewed at high risk where the marketplace area
  is reviewed, and a revert (a rejected review) never raises a cap or switches the stop off. While
  the stop is on, `status` answers `emergency-stop` and `run` answers `off`. The saver threshold
  moved with the priority lists (G4b); the alert threshold waits for the alerts
  (FE-20261125-ai-gateway-budget-alerts).
- **Server checks.** Every rule of the page is checked on the server too: a model without a key,
  without a passed evaluation, with a region that does not meet the Market's requirement or retired
  is refused in a priority list.
- **Built in G4b (priority lists, saver model and threshold).** Settings `ai-models-<task>` (`none`
  or 1 to 3 catalogue families, comma-separated, in the order to try; a family is at most 20
  characters and never `none`), `ai-saver-<task>` (`none` or one family) for chat, extract, write
  and vision, and `ai-saver-percent` (50 to 99, default 80). `GET settings/admin/ai-models` (key
  `settings.ai-gateway.view`) also lists, per task type, every catalogue family and why it cannot
  be chosen now. `PUT settings/admin/ai-models` needs the protected key `settings.ai-models.manage`
  and spends the admin step-up `settings.ai-models.change` for every change that saves something.
  The server checks run in the change's unit through `platform/ai`'s `AiModelChoices` (boundary
  rule `ai-model-choices-only-from-settings`), on the page as it would stand and only for the task
  types changed: each family is in the catalogue, once, and for every registered capability of
  the task type one of its routes is usable (Hassan's check, region, key, not retired, evaluated;
  with no capability of the task type yet, every condition but the evaluation); a saver model
  passes the same checks, needs a list and is cheaper than its model 1. A failed check is
  `validation.failed` with the path `<code>.<index>` or `<code>`. The audit row counts the models
  (`settings.ai-models.changed`, no free text, ADR-0009); the families are on the history row.
  Reviewed at high risk; a rejected change is restored (the router checks every route again on
  each call, so a restored list that went stale only skips that model). The gateway reads the
  lists with the caps; a task type with a list uses it, and only a task type without one still
  uses the family the module's tier names (the `tier` option goes in G4d). Saver mode uses the
  task type's saver model at the Market's threshold. Market configuration `aiRouting` keeps only
  the residency. The page's list and saver rules are advisory for a pair: two admins saving the list
  and the saver model at once, or a review that restores only one of them, can leave a pair the
  page would refuse; the router enforces on every call (a saver model goes first only when usable
  and cheaper than the first usable model, priced like the plan: the family's routes usable in the
  Market). The view key shows each family's problem (`no-key`, `not-checked` …) to Viewer staff;
  no key value or route detail (Hassan G4b review, informational).
- **Built in G4c1 (evaluation runs and the playground, capabilities without tools).** A module
  declares an `EvaluationSuite` per capability in its `contracts/ai-evaluation-suites.ts` (catalog:
  the description writer's set through its real prompt builder, graded with its own draft guard:
  `leak`, `empty`, `missing-fact`, `incomplete`, `too-long`) and registers it with
  `registerEvaluationSuites`; the registry refuses the owner `platform`, a foreign or unknown
  capability, one with tool rounds, a duplicate, and a sample request with tools. The evaluation
  gateway (`evaluations/evaluation-gateway.ts`, imported only inside `evaluations/`) runs one
  sample on one model through the same call path as the gateway (`model-call.ts`), on
  `AiRouter.evaluationPlan` (the one exception of ADR-0052 decision 3: every condition but the
  pass), for the system actor or an admin not acting as someone else; it reserves only on the
  evaluation budget (`ai-cap-evaluation-month`, micro-dollars, no `none`, default 0, raised with
  the step-up `settings.ai-gateway-limits.raise`; usage id `platform.ai-evaluation`, budget scope
  `evaluation`), so no Market, capability, seller or guest counter moves. **Close rule, Option B
  (owner decision, 25 Nov 2026; one function, `closedBySaverThreshold`):** evaluations are closed while
  the Market's month share is at or above the saver threshold; also closed by the kill switch,
  the emergency stop, an unreadable setting or a full evaluation budget. The job
  `platform.ai-evaluation-runner` (every 15 s, 300 s slot) takes one run per tick with a lease
  token (a conditional UPDATE), renews it before each sample, stops on a cancel or a lost lease,
  hands the run back before a sample that could outlive its slot, inserts each sample once and
  sets each capability's verdict from the stored samples. A result or a verdict is written only
  while the job still holds the run: in its unit, a conditional UPDATE of the run (id, token,
  running) proves and locks the lease first, so after a cancel or another job's claim the write is
  refused and the job stops (Mojtaba and Hassan, PR 1367). Verdicts: `pass-candidate` (never a pass: a PR records a pass in
  `evaluations/results.ts`), `failed`, `incomplete`, `superseded` when the prompt or set version
  changed. Routes under `settings/admin/ai-models/`: `GET evaluations`, `GET
  evaluations/estimate`, `GET evaluations/{runId}`, `GET playground/samples` (view key); `POST
  evaluations` (protected `settings.ai-models.manage` and the step-up
  `settings.ai-evaluation.run`; the estimate the admin confirmed must still hold; step-up spend,
  queueing and the audit row `settings.ai-evaluation.requested`, numbers only, in one unit),
  `POST evaluations/{runId}/cancel` (manage key; the cancel and its audit row
  `settings.ai-evaluation.cancelled`, the run id only, in one unit) and `POST playground` (manage
  key; ids only, two distinct families called in parallel, 20 runs per admin per Market day;
  nothing stored but the audit row `settings.ai-playground.run`: how many models and what they
  spent). Tables
  `platform.ai_evaluation_runs`, `_capabilities`, `_samples` and `ai_playground_days` (migration
  `20261125230000_platform_ai_evaluations`; runs kept 25 months, playground days 90 days, purged
  by the usage retention job: samples first, 20 runs a unit). The tables' CHECKs hold a run's life
  (open exactly while it has no end, no lease while queued, a start once running, no end before
  the start) and a sent call's route and attempt; the application updates only the columns it
  changes (column-level grants). No event, no notification (R2).
- **Accepted in G4c1: a queued run does not re-check its requester** (Hassan, PR 1367 L4). The job
  works a run as the system actor; it does not ask again whether the admin who asked for it still
  holds `settings.ai-models.manage`. Doing so needs `platform/ai` wired to identity's job identity
  and authorisation ports, the requester's session id on the run and settings' permission key in
  `platform/`, a new cross-module dependency not built here. The spend is bounded by the
  evaluation budget, and any admin with the key can cancel the run
  (FE-20261125-ai-gateway-evaluation-requester-recheck).
- **Total AI spend of a Market** (Hassan, PR 1367 I2): evaluation and playground calls count only
  on the evaluation budget, never on the Market's day or month caps, so a Market can spend up to
  its month cap plus its evaluation cap in a month. The evaluation cap is 0 until a senior admin
  raises it. **G4c2 (deferred):** capabilities
  with tool rounds, the buyer chat (FE-20261125-ai-gateway-evaluation-tool-capabilities).

## 9. Security (Hassan)

- **Keys** live in the environment's secret manager, one per provider and Market, plus separate keys
  for the fallback route and the partner endpoint. Never in the database, a log, the panel or the
  browser. Keys are read at boot today, so a key rotation needs a server restart, not a release
  (reload without restart: FE-234).
- **Personal data.** The control is each capability's field allow-list: no payment, identity,
  address or phone data reaches a model (R2, ADR-0019 decision 3). Masking today catches only
  emails and digit runs of 8 or more, and runs only on the buyer's typed text. It moves to
  `platform/ai`, grows (email, phone, card number), and runs on every part of the request.
- **Prompt injection.** User text, files and tool results are always data, never instructions. A
  model has no tool that changes data (R4). Output is made inert and every id a model returns meets
  the ownership check (R3).
- **Isolation between Markets and sellers.** Market and seller ids come only from the user's session,
  never from model input or output. Canary tests in CI check that no data crosses sellers, customers
  or Markets.
- **Second route and partner team.** Before activation Hassan checks their no-retention contract and
  processing region; the result is recorded in the route's catalogue row (date, reference, Hassan),
  which is the only record the router reads. ADR-0052 keeps a log of these checks for reference.
- **Logs.** For an error, only the error kind is logged, never the provider's error text.
- **Security review** is mandatory for every gateway PR (R15).

## 10. Data and storage (Mojtaba)

Tables follow the platform-table rule: schema `platform`, prefix `ai_`. Market isolation is in the
application layer as in the rest of the project: `market_id` leads the key and access goes through
the guarded `prisma.tx(market)` client. Each table has an explicit GRANT and `down.sql` reverts it.

| Table                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                    | Retention                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `platform.ai_calls`               | One row per call: Market, capability, seller (if any), provider, model, attempt, input and output tokens, unit price used, cost, latency and outcome. No text, customer id, IP or personal key.                                                                                                                                                                                                                            | 90 days. A scheduled job deletes old rows in batches, like the security-events table. No partitions. |
| `platform.ai_usage_days`          | Daily totals per Market, capability and seller: settled cost, calls, errors, refusals and fallbacks, and latency counts in fixed buckets from which p95 is computed.                                                                                                                                                                                                                                                       | 25 months                                                                                            |
| `platform.ai_budget_counters`     | One row per Market, period (day or month, in the Market's zone) and cap scope (Market, capability, seller, guest pool): `held` (settled plus reserved; the reserved cost lives here, not in the day rows) and `spent`. Added in G2 (Mojtaba): a month cap cannot be one conditional UPDATE over day rows. Key `(market_id, period_start, period, scope, scope_key)`, so the retention's `period_start <` is a range on it. | 25 months                                                                                            |
| `platform.ai_budget_reservations` | Temporary reservation with an expiry; deleted on settle or expiry.                                                                                                                                                                                                                                                                                                                                                         | Minutes                                                                                              |
| Settings                          | Priority lists, saver model and threshold, caps, guest share, in-house stage, shadow share and rollback limits in the existing store (`settings.market_settings`), versioned with history. Routes are code (ADR-0052).                                                                                                                                                                                                     | Versioned                                                                                            |

- **Atomic reservation.** For each cap (Market day, Market month, capability, seller) a separate
  `UPDATE … WHERE held <= cap - est` on `ai_budget_counters`, all in one short unit in the fixed
  order most specific first: seller or guest pool, capability, Market day, then Market month, so no
  deadlock arises and the Market rows every call shares are held for the shortest time (Mojtaba,
  PR 1348). The unit inserts the reservation's row first and updates the counters last, so the
  commit follows the last counter UPDATE. It is outside the main work's transaction and waits at
  most 1 s for a row lock (`lockTimeoutMs`), after which the call is off. The counter rows are
  created first with `INSERT … ON CONFLICT DO NOTHING`.
- **Settle once.** The reservation is taken (read, then `DELETE`; of two takes one deletes the row)
  and the counters are corrected in the same unit, with the call's row (its id is the reservation's)
  inserted `ON CONFLICT DO NOTHING`: a second settle finds the row and changes nothing. A settle
  after the sweeper counted the estimate as spent writes the call's row and its day totals and
  leaves the counters. A settle is tried three times; one that still fails is logged as an error.
  Settlement is written to the reservation's day,
  so a call that crosses midnight is counted right.
- **Day-row key.** With no seller the seller column is null, so the day-row key is a unique index
  with `NULLS NOT DISTINCT`.
- **Auto-off and once-a-day notice.** The columns that live in `spend_days` today move to
  `ai_budget_counters`, where the caps are counted (G7).
- **Expected load (reviewed with retries in G3, Mojtaba).** Every attempt reserves and settles on
  its Market's day and month rows: 2 units an attempt, up to 3 attempts a run, so at most 6 units a
  run (saver mode adds one lock-free read). The rows take about 300 to 500 units a second before
  they queue, which is about 50 to 80 runs a second in the worst case (every run using 3 attempts);
  the launch expects well under 10 runs a second per Market (at most about 60 units a second). No
  sharding now. Split the Market rows into shards when lock waits on `ai_budget_counters` show up or
  `ai.usage.settle-failed` errors are logged. Later (G4 or after): on a zero-cost failure (a server
  error or a rate limit), keep the reservation for the next attempt instead of releasing it and
  reserving again, which removes 2 units per fallback.
- **Moving `spend_days` in four steps (G7):** create the new table and backfill it; write to both;
  switch the readers (the buyer assistant's cap and its statistics page) through a gateway port;
  drop the old table in a later release, with a full `down.sql`. The "cap reached" event and the
  conversation statistics stay.
  - Built (G7a, migration `20261125150000_assistant_spend_days_expand`): `assistant.conversation_days`
    holds the daily conversation count (the one column of `spend_days` that is the assistant's own);
    `ai_budget_counters` gains `cap_reached_at` and `cap_reached_period`, set once on the capability's
    day row (CHECK: only there). The migration copies both, and adds to the gateway's day rows and
    counters only the part of each day's `spend_days` spend the gateway did not count (calls before
    G2) on days up to the Market's first gateway day, in one statement; every step can run again
    after a failure part way through and adds nothing twice (Mojtaba, PR 1354). Deploy G2's code
    everywhere before this migration runs. The cap-reached record lives on a counter row, so it is
    kept 25 months (spend_days kept it for ever): after that "last auto-off" may read as never. The assistant writes both homes in the same unit; the
    spend needs no second write (the gateway counts every call since G2).
  - The port is `AiUsageReport` (`platform/ai/usage/ai-usage-report.ts`): `for(owner)` gives a module
    the handle of its own capabilities (another owner's id is refused, Hassan PR 1354): settled cost
    per day and the "cap reached" record, in the caller's unit; a day after the Market's day of the
    record's instant is refused. It never changes what is held or spent, and only the files on
    `AI_USAGE_REPORT_ALLOW_LIST` import it.
  - Built (G7b, migration `20261125163000_assistant_spend_days_switch`): the readers switched. The
    assistant's cap check and its insights page read the buyer chat's settled cost through the port
    and the conversations from `conversation_days`; the auto-off record is the gateway's. `spend_days`
    is neither written nor read. The cost of each call is settled inside `run`, before the runtime
    answers, so the turn that crosses a cap sees it in its own write unit and sends the event once;
    nothing is counted twice (the assistant no longer adds spend) and there is no gap (the gateway
    counted every call since G2, and the migration re-runs the reconcile for old pods). The spend is
    the buyer chat's day counters' `spent` (a partial index answers the month), so a call whose
    settle failed is counted at its estimate by the sweeper, never missed (Hassan, PR 1356). The
    switch's `down.sql` copies what only the new homes hold back into `spend_days`, so the G7a
    release can run again. While G7a and G7b pods run side by side during the rollout, a day can
    send the cap event twice and G7a pods read less spend; roll out quickly (Mojtaba, PR 1356).
    The cap values stay in the assistant's settings until G4 moves them to the gateway's caps
    (FE-20261125-ai-gateway-assistant-cap-to-gateway); step 4 is FE-20261125-ai-gateway-drop-spend-days.

## 11. Monitoring and audit

- **Metrics:** calls, error rate, p50 and p95 latency, fallbacks and cost, per capability, model and
  Market, from `ai_usage_days`.
- **Alerts for Kazem:** error rate above 5 % over 10 minutes, a circuit breaker opening, spend at
  80 % of a cap.
- **Audit:** every gateway setting change, emergency stop and switch-on again is recorded with user,
  time, old value and new value.
- **Suggestion against decision:** as today, in the module that owns the data, with the gateway's
  call id (R12). For example the seller assistant records its changes with `source=assistant`.

## 12. Build plan

| PR  | Scope                                                                                                                                                                                                                                                                                                                     | Depends on                                                                              | Reviewers                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| G0  | Docs only: this document, ADR-0052, ADR-0053, the ADR-0019 decision 2 amendment, the future-enhancement rows                                                                                                                                                                                                              | —                                                                                       | Ali (CTO), Mohammad, Hassan |
| G1  | Capability registry, `run` and `status`, the seller-switch port, the generic masker. The buyer assistant and the description writer move to `run` and `status`; no user-visible change.                                                                                                                                   | G0                                                                                      | Mohammad, Hassan            |
| G2  | Usage and reservation tables, central caps, parallel counting. Cap values come from per-Market configuration `aiBudget` until G4 and are enforced from G2 where set; the assistant's `spend_days` cap is not moved before G7                                                                                              | G1                                                                                      | Mojtaba, Hassan             |
| G3  | Router with priority lists, saver mode, circuit breaker, second adapter. Until G4 each task type's list is the single catalogue row today's tier maps to; the `tier` option stays until G4                                                                                                                                | G2, ADR-0052 and Hassan's verification of the first route recorded in its catalogue row | Mohammad, Hassan            |
| G4a | Caps and the Market's emergency stop in `settings`, read by the gateway through a port; API, protected key, conditional TOTP, audit                                                                                                                                                                                       | G3                                                                                      | Hassan, Mohammad            |
| G4b | Priority lists per task type, saver model and threshold in `settings`, server checks, router reads them                                                                                                                                                                                                                   | G4a                                                                                     | Hassan, Mohammad            |
| G4c | Background evaluation run with its separate budget, and the playground by sample id                                                                                                                                                                                                                                       | G4b                                                                                     | Hassan, Mojtaba             |
| G4d | Capability switches into these settings, the assistant's cap values into the gateway caps (FE-20261125-ai-gateway-assistant-cap-to-gateway), the panel's "revert to a previous version" as a forward change with TOTP, and the `tier` option goes (moved from G4b: it touches the assistant's and catalog's own settings) | G4b                                                                                     | Hassan, Mojtaba             |
| G5  | Admin pages AI Models (external tab, scorecard, playground, change preview) and AI Gateway                                                                                                                                                                                                                                | G4                                                                                      | Reza (UI/UX)                |
| G6  | In-house model tab: shadow, percent rollout, auto rollback, HTTP contract                                                                                                                                                                                                                                                 | G4, G5 and Hassan's approval                                                            | Mohammad, Hassan            |
| G7  | Move `spend_days` in four steps                                                                                                                                                                                                                                                                                           | G2                                                                                      | Mojtaba                     |

- G1 and G2 merge before the seller assistant's first PR.
- G2 to G4 all touch the gateway's main pipeline, so they are built one after another. G5 and G7
  share no files and can be built in two parallel threads.

## 13. Owner decisions (25 Nov 2026)

| Question                                       | Decision                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1. Fallback model during an outage            | The same model through a second hosting route in the Market's region                                                                                                         |
| Q2. Chat window in the seller and admin panels | ADR-0019 decision 2 amended for the seller panel only (ADR-0053 decision 7)                                                                                                  |
| Q3. Model choice in the panel                  | Section «AI Models» with two tabs, several external models with priorities; recorded in ADR-0053, which supersedes ADR-0026 decision 9 and ADR-0042 decision 7 for AI models |
| Q4. Who changes gateway settings               | Senior admin only                                                                                                                                                            |
| Admin assistant                                | Not designed now (FE-235)                                                                                                                                                    |
| Models                                         | External models only for now; the in-house model joins later behind the same contract                                                                                        |
| Login as Seller                                | The assistant is off in an acting-as session (R3)                                                                                                                            |

## 14. Deferred (future-enhancements register, area `assistant`)

| Id                                              | Item                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FE-231                                          | Connect the in-house model behind the gateway, shadow then percent rollout                             |
| FE-232                                          | Sentence-by-sentence streaming, each sentence checked before it is sent                                |
| FE-233                                          | Answer cache, only for answers built from help-centre text alone, per Market                           |
| FE-234                                          | Key reload without a server restart                                                                    |
| FE-235                                          | A design of its own for the admin assistant                                                            |
| FE-20261125-ai-gateway-budget-alerts            | Admin notice at 80 % and 100 % of an AI budget cap (G2 counts and refuses only)                        |
| FE-20261125-ai-gateway-ops-alerts               | Kazem's alerts: error rate, circuit breaker, spend at 80 %                                             |
| FE-20261125-ai-gateway-region-check             | Compare a provider-reported processing region with the route row; a mismatch fails the call and alerts |
| FE-20261125-ai-gateway-shared-breaker           | One circuit-breaker state shared by all API instances, shown on the AI Gateway page                    |
| FE-20261125-ai-gateway-bedrock-price            | Record the Bedrock Sydney price in the catalogue rows before the route is turned on                    |
| FE-20261125-ai-gateway-bedrock-endpoint-check   | Confirm the Bedrock Mantle endpoint, model id and key length with AWS before the row gets its check    |
| FE-20261125-ai-gateway-bad-answer-cost          | Count a billed 200 answer without content at its worst-case cost, not 0                                |
| FE-20261125-ai-gateway-keep-reservation         | Keep a reservation for the next attempt after a zero-cost failure (2 hot-row units less per fallback)  |
| FE-20261125-ai-gateway-saver-model-check        | Obsolete (G4b): the saver model is a setting, checked on the server when saved                         |
| FE-20261125-ai-gateway-drop-spend-days          | G7 step 4: drop `assistant.spend_days` one release after G7b                                           |
| FE-20261125-ai-gateway-assistant-cap-to-gateway | Move the assistant's day and month cap values into the gateway's caps (with G4)                        |
| FE-20261125-ai-gateway-evaluation-tool-capabilities | G4c2: evaluation runs and the playground for capabilities with tools (the buyer chat) |
| FE-20261125-ai-gateway-evaluation-requester-recheck | Re-check the requesting admin's access before a queued evaluation run starts (accepted risk in G4c1) |
