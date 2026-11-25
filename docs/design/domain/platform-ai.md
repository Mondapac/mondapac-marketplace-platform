# Platform AI: the AI Gateway (`platform/ai`)

**Author:** Mohammad (software-architect), from the owner-approved design
`design/ai-gateway/ai-gateway-design-fa.html` (version 3, project files), 2026-11-25
**Status:** Accepted on the owner's decision («ساخت», 25 Nov 2026), with the decisions of section
13. Reviewed on the design by Mohammad (software-architect), Hassan (security-tester) and Mojtaba
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

| Topic | Today | State | Code |
|---|---|---|---|
| One model entry point | Every call goes through `ModelGateway.complete`, with a timeout, never inside a UnitOfWork | Ready | `model-gateway.ts` |
| Provider-neutral shape | Messages, tools, token usage and stop reason are our own types | Ready | `model-provider.ts` |
| Provider | One adapter for the Anthropic Messages API, no streaming (on purpose: the whole answer is checked before it is shown) | Partial | `anthropic-messages.provider.ts` |
| Model choice | Two tiers, `fast` and `balanced`; model id, key and price per Market from `ASSISTANT_MODEL_*`, read at boot only | Partial | `app-config.ts` |
| Fallback | None: an error means "unavailable" and the host flow completes without AI | Missing | `model-gateway.ts` |
| Kill switch | `AI_KILL_SWITCH` turns everything off | Ready | `model-gateway.ts` |
| Capability and seller switches | Each module reads its own: the assistant from its settings, the description writer from `settings` and `sellers` | Partial | `description-writer-switches.ts` |
| Spend cap | Only the buyer assistant (`assistant.spend_days`); the description writer counts drafts per day only | Partial | `prisma-spend.repository.ts` |
| Request limits | Per guest and per customer in the buyer assistant, on a PostgreSQL counter | Partial | `subject-message-limits.ts` |
| Usage record per call | Only an error log (Market, tier, failure kind); no latency, model or cost | Missing | `model-gateway.ts` |
| Admin settings | Switch and tier per capability; provider and model were never panel settings (until ADR-0053) | Partial | `settings/domain/definitions.ts` |

## 2. Consumers
| Consumer | State | Task types | Special need |
|---|---|---|---|
| Buyer assistant (`assistant`) | Stages 0 and 1 built | chat with READ tools, extract, later vision | High volume, a separate guest pool, a multi-round tool loop (each round is one `run`) |
| Seller assistant (seller panel) | Designed 25 Nov, waits for «ساخت» | understand an instruction, match a price list | Cap per seller, per-seller switch (SEL-25), tools only under the seller's own session |
| Admin assistant | No design (FE-235, owner: "not now") | summary, draft text, report explanation | No tools under an admin (R9); the page supplies the input |
| Description writer (`catalog`, AIS-03) | Built | write | Joins the central caps and usage record |

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

| Job | Where | Notes |
|---|---|---|
| Capability definition | The owning module, in `contracts/` | Each module registers its capabilities at boot (`assistant.buyer-chat`, `catalog.description-writer`, ...). A spec carries task type, audience, seller-scoped or not, input and output token caps, max tool rounds, timeout and prompt version. The gateway validates only; an unknown or duplicate capability fails boot. |
| Field allow-list and output guard | The owning module | The gateway receives a request the module already built, so it cannot know where a field came from; the claim rule needs `certification` data. A CI test with a fake provider (ADR-0019 decision 9) proves no field outside the allow-list leaves. |
| Switches | Gateway | Evaluated in this order: kill switch, capability switch for the Market, and the seller's switch through the `sellers` port when the capability is seller-scoped. An acting-as session ("Login as Seller") is always off. Any error means off. |
| Budget and limits | Gateway | Reserve before the call, settle after it (section 7). |
| Generic masking of personal data | Gateway | Email, phone and card numbers are masked in every part of the request, tool results included. Second line of defence only: the field allow-list is the control that keeps address, phone and payment data out. |
| Router and adapters | Gateway | Reads the task type's priority list and calls with a timeout (section 6). |
| Generic output check | Gateway | Schema check, HTML and links made inert. |
| Usage record | Gateway | One row per call, never the text (section 10). |

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
**Internal contract.** Modules no longer send a model tier or a model name; they name the
capability. One `run` is one model round: the buyer assistant, which loops over tools, calls `run`
once per round. Cost comes back on success and failure, because a provider may bill a call that
ran out of time.

```ts
gateway.status(capability, market, sellerId?)
  → { on: boolean, reason?: 'kill-switch' | 'off' | 'no-route' | 'over-budget' }

gateway.run(capability, context: CallContext, request: ModelRequest, opts?: { sellerId? })
  → { ok: true,  turn, route: { provider, model, attempt }, cost }
  | { ok: false, reason: 'off' | 'over-budget' | 'rate-limited' | 'unavailable'
                       | 'timeout' | 'rejected-output', cost }

CapabilitySpec = { id, audience: 'buyer' | 'seller' | 'admin' | 'system',
                   task: 'chat' | 'extract' | 'write' | 'vision', sellerScoped,
                   maxInputTokens, maxOutputTokens, maxToolRounds, timeoutMs, promptVersion }
```

Until the router lands (G3), a capability's route is the Market's configured tier, passed by the
owning module from its existing setting; G3 replaces it with the priority list and the option goes.

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
  has not passed a capability's evaluation is neither its primary nor its fallback; with no valid
  fallback, an outage switches the capability off.
- **Data gate.** A fallback must also meet ADR-0019 decision 3 (no retention, no training,
  processing in the Market's region). A model whose region is not recorded cannot be chosen.
- **Fallback route (owner decision, Q1).** The same model through a second hosting route in the
  Market's region (for AU, for example Amazon Bedrock in `ap-southeast-2`), so the evaluation and
  prompt stay the same. It covers an outage of the primary service, not a fault of the model
  itself. It is enabled only once ADR-0052 records it as verified.
- **Shadow mode (in-house model).** A share of requests is also sent to the second model; its answer
  is never shown to anyone or stored. Only metrics are compared: tokens, latency, valid-output rate
  and guard-rejection rate. Shadow runs only for single-round capabilities without tools and its
  cost comes out of the same budget. Before the first shadow request the partner endpoint must meet
  ADR-0052 and Hassan approves it. Customer data goes to shadow only with the owner's written
  approval.

## 7. Cost and limits
- **Unit.** Cost is recorded in US micro-dollars, because providers bill in dollars; the panel also
  shows an approximate amount in the Market's currency.
- **Caps.** Daily and monthly per Market, per capability, daily per seller, and a separate guest
  share so guest traffic cannot use the whole budget. Caps are hard: when one is full, the
  capability is off until the next day or month.
- **Reserve before the call.** The largest possible cost is reserved first, at the price of the most
  expensive model on the route, and settled with the real figure after the answer, so concurrent
  requests cannot pass the cap. A reservation not settled because a server died has an expiry and a
  scheduled job releases it.
- **Cost guards.** Each capability has an input token cap, an output token cap and a max tool-round
  count. Guest-id creation is limited per IP.
- **Alerts.** At 80 % of a cap the admin is notified. At 100 % the capability switches off and at
  most one more notice is sent per day.
- **Message limits** stay in the module: the gateway counts model rounds, not user messages.
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
  processing region, the gateway checks it too.
- **Price.** From the price table in the repository, never from the panel: a price below reality
  would shrink the reservation and void the cap. Each month the gateway's total is compared with the
  provider's invoice and a mismatch raises an alert.
- **Evaluation.** A new model is "not evaluated". "Run evaluation" runs each capability's synthetic
  evaluation set on the real model in a background job. The estimated cost is shown first and
  confirmed with TOTP; the cost comes out of a small separate evaluation budget, not the assistants'
  caps. One run per model at a time; closed once spend reached the saver threshold. A panel result
  is only a "pass candidate", bound to provider, model, prompt version and evaluation-set version; it
  becomes "passed" when a small PR records it in the results file. Only a model passed for a task
  type enters that type's priority list.
- **Priority.** Per task type a list of up to 3 models plus one saver model. Each assistant uses
  these lists by default and may get its own. Every list, assistant lists and saver model included,
  passes the same server checks. The saver model must be cheaper than model 1.
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
- **Conditions:** each version passes the evaluation before any stage other than off. The endpoint
  address changes only by PR. Customer data reaches shadow only with the owner's written approval.

**AI Gateway page.** Tabs Overview (today's and this month's cost against the caps, requests,
errors, latency and fallbacks per capability), Limits (caps, guest share, alert and saver
thresholds) and Capabilities (state of each capability, linking to its own settings). The
emergency stop for all AI of a Market sits on top of this page. Switches that exist today (the
description writer's, the buyer assistant's) are not rebuilt.

| Set in the panel | Not in the panel |
|---|---|
| Add a model from the allow-list of the connected providers | The per-provider model allow-list and its price table (by PR). Connecting a new provider: Kazem puts the key in the server's secret manager and Hassan approves the no-retention contract and region; the panel only shows "connected". |
| Priority list per task type and saver model | API keys |
| In-house model stage and auto-rollback limits | The in-house endpoint address (by PR only) |
| Caps, guest share and thresholds | Safety rules, field allow-lists, masking, prompt text and evaluation sets |
| Emergency stop for one Market | The server-wide `AI_KILL_SWITCH` (Kazem only) |

- **Permissions:** `settings.ai-models.manage` and `settings.ai-gateway.manage` to change,
  `settings.ai-gateway.view` to see, named per ADR-0042. Each admin changes only their own Market.
  Only a senior admin is given the change permissions (owner decision, Q4).
- **In-place confirmation (owner decision).** The admin is not signed out: a small dialog asks for
  the six-digit TOTP code, the mechanism of the seller payout and wallet pages. These changes need
  it: adding or removing a model; changing a priority list, the saver model or the saver threshold;
  running an evaluation from the panel; loosening auto-rollback limits; changing the in-house stage;
  raising a cap; switching a capability on, or on again after an emergency stop; reverting settings
  to a previous version. Switching something off never needs confirmation.
- **Versions and revert.** Each change in the ADR-0042 store has a version and an audit row. A
  revert is a new forward change and passes the same server checks and confirmation.
- **Server checks.** Every rule of the page is checked on the server too: a model without a key,
  without a passed evaluation, with a region that does not meet the Market's requirement or retired
  is refused in a priority list.

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
  processing region; the result is recorded in ADR-0052.
- **Logs.** For an error, only the error kind is logged, never the provider's error text.
- **Security review** is mandatory for every gateway PR (R15).

## 10. Data and storage (Mojtaba)
Tables follow the platform-table rule: schema `platform`, prefix `ai_`. Market isolation is in the
application layer as in the rest of the project: `market_id` leads the key and access goes through
the guarded `prisma.tx(market)` client. Each table has an explicit GRANT and `down.sql` reverts it.

| Table | Content | Retention |
|---|---|---|
| `platform.ai_calls` | One row per call: Market, capability, seller (if any), provider, model, attempt, input and output tokens, unit price used, cost, latency and outcome. No text, customer id, IP or personal key. | 90 days. A scheduled job deletes old rows in batches, like the security-events table. No partitions. |
| `platform.ai_usage_days` | Daily totals per Market, capability and seller: settled cost, reserved cost, calls, errors and fallbacks, and latency counts in fixed buckets from which p95 is computed. | 25 months |
| `platform.ai_budget_reservations` | Temporary reservation with an expiry; deleted on settle or expiry. | Minutes |
| Settings | Routes, caps and shadow share in the existing store (`settings.market_settings`), versioned with history. | Versioned |

- **Atomic reservation.** For each cap (Market day, Market month, capability, seller) a separate
  `UPDATE … WHERE spent + reserved + est <= cap RETURNING`, all in one short unit in a fixed order
  so no deadlock arises. The unit is outside the main work's transaction. The day row is created
  first with `INSERT … ON CONFLICT DO NOTHING`.
- **Settle once.** The reservation is taken with `DELETE … RETURNING` and the counter is corrected
  in the same unit; running it again has no effect. Settlement is written to the reservation's day,
  so a call that crosses midnight is counted right.
- **Day-row key.** With no seller the seller column is null, so the day-row key is a unique index
  with `NULLS NOT DISTINCT`. The auto-off and once-a-day-notice columns that live in `spend_days`
  today move to this table.
- **Moving `spend_days` in four steps (G7):** create the new table and backfill it; write to both;
  switch the readers (the buyer assistant's cap and its statistics page) through a gateway port;
  drop the old table in a later release, with a full `down.sql`. The "cap reached" event and the
  conversation statistics stay.

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
| PR | Scope | Depends on | Reviewers |
|---|---|---|---|
| G0 | Docs only: this document, ADR-0052, ADR-0053, the ADR-0019 decision 2 amendment, the future-enhancement rows | — | Ali (CTO), Mohammad, Hassan |
| G1 | Capability registry, `run` and `status`, the seller-switch port, the generic masker. The buyer assistant and the description writer move to `run` and `status`; no user-visible change. | G0 | Mohammad, Hassan |
| G2 | Usage and reservation tables, central caps, parallel counting | G1 | Mojtaba, Hassan |
| G3 | Router with priority lists, saver mode, circuit breaker, second adapter | G2 and ADR-0052 | Mohammad, Hassan |
| G4 | «AI Models» and gateway settings in `settings`, with API, permissions, TOTP confirmation, audit and the background evaluation run | G3 | Hassan, Mojtaba |
| G5 | Admin pages AI Models (external tab, scorecard, playground, change preview) and AI Gateway | G4 | Reza (UI/UX) |
| G6 | In-house model tab: shadow, percent rollout, auto rollback, HTTP contract | G3 and Hassan's approval | Mohammad, Hassan |
| G7 | Move `spend_days` in four steps | G2 | Mojtaba |

- G1 and G2 merge before the seller assistant's first PR.
- G2 to G4 all touch the gateway's main pipeline, so they are built one after another. G5 and G7
  share no files and can be built in two parallel threads.

## 13. Owner decisions (25 Nov 2026)
| Question | Decision |
|---|---|
| Q1. Fallback model during an outage | The same model through a second hosting route in the Market's region |
| Q2. Chat window in the seller and admin panels | ADR-0019 decision 2 amended for the seller panel only |
| Q3. Model choice in the panel | Section «AI Models» with two tabs, several external models with priorities, superseding ADR-0053 |
| Q4. Who changes gateway settings | Senior admin only |
| Admin assistant | Not designed now (FE-235) |
| Models | External models only for now; the in-house model joins later behind the same contract |
| Login as Seller | The assistant is off in an acting-as session (R3) |

## 14. Deferred (future-enhancements register, area `assistant`)
| Id | Item |
|---|---|
| FE-231 | Connect the in-house model behind the gateway, shadow then percent rollout |
| FE-232 | Sentence-by-sentence streaming, each sentence checked before it is sent |
| FE-233 | Answer cache, only for answers built from help-centre text alone, per Market |
| FE-234 | Key reload without a server restart |
| FE-235 | A design of its own for the admin assistant |
