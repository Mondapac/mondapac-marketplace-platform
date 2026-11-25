# ADR-0052: AI Providers, Hosting Routes and Processing Regions

**Status:** Accepted — 2026-11-25 (owner decisions in the AI Gateway design, version 3,
`design/ai-gateway/ai-gateway-design-fa.html`: external models only for now, the in-house model
later behind the same contract, the fallback is the same model on a second hosting route; build
approved with «ساخت» on 2026-11-25). Drafted by Mohammad (software-architect); Ali (cto) and Hassan
(security-tester) review the G0 PR. This is "ADR 3" of ADR-0019 decisions 3 and 12.
**Amends:** ADR-0019 decision 12 (closes the "ADR 3" item: provider, model, region, residency
value, data categories, contract and cost cap are decided here or by the mechanism recorded here)
**Relates to:** ADR-0019 R7, R8 and decisions 3 and 9; ADR-0002 decision 1 and INTL-53
(`Market.data_residency_requirement`); ADR-0003 decision 5; ADR-0053 (model choice in the admin
panel); `docs/design/domain/platform-ai.md` sections 6, 8 and 9

## Context
ADR-0019 decision 3 sets the floor for any data sent to a model: a contract with no retention and no
training, and processing that satisfies the Market's data-residency requirement. It left the
provider, model and region to "ADR 3". The code already has one adapter (the Anthropic Messages
API) and reads key, model id and price per Market from environment variables. The gateway design
adds several external models per Market, ranked per task type, a fallback route, and later an
in-house model. Each of them sends Market data out of the platform, so each needs the same proof of
contract and region before it is used, and the panel must not be able to bypass that proof.

## Decision
1. **A route is the unit of approval.** A route is one provider, reached through one hosting
   service, in one processing region, under one contract (for example: model family X through the
   provider's own API; the same family through Amazon Bedrock in `ap-southeast-2`). Data reaches a
   model only through an approved route.
2. **The route catalogue is code.** `platform/ai` keeps a checked-in catalogue, one file per
   provider, with one row per allowed model: the exact model version id, the route and processing
   region, the no-retention and no-training status with the date and reference of Hassan's check,
   input and output price per million tokens in US dollars, and the retirement date. A row is added,
   changed or removed only by PR, with Hassan's review. The panel picks from this catalogue and never
   types a model id (ADR-0053); the server refuses any id outside it.
3. **Conditions for a route to be usable** (all of them, checked on the server; any one missing
   means the route is not usable and, with no other route, the capability is off per R8):
   - no retention and no training, including provider-side logs and abuse-monitoring copies, as
     recorded by Hassan in the catalogue row;
   - a processing region recorded in the row that satisfies the Market's
     `data_residency_requirement`; a row without a region is never usable;
   - a server key for that provider and Market in the environment's secret manager (Kazem); keys
     never live in the database, a log, the panel or the browser;
   - a passed real-model evaluation for the capability, bound to provider, model and prompt version
     (ADR-0019 decision 9), recorded in the repository's evaluation-results file;
   - not past its retirement date.
   When a provider reports the processing region in its answer, the gateway compares it with the
   row and treats a mismatch as a failed call.
4. **Residency value for the first Market.** For AU the owner's condition ("processing of
   documents in Australia", ADR-0019 decision 3) is recorded as the residency value
   `in-market-region`: processing in an Australian region (for the hosting services in use, Sydney,
   `ap-southeast-2` or the provider's equivalent). A Market whose value does not express a
   condition (for example `none`) keeps AI off until an ADR records its value.
5. **Providers now: external only.** The provider in code today (the Anthropic Messages API) stays
   the first route. The fallback is the same model family through a second hosting route in the
   Market's region (owner decision Q1), so the evaluation and the prompt stay valid. Each route
   becomes usable only when its catalogue row carries Hassan's verification of decision 3; until
   then the row is present but not usable, and the capability stays off for that route.
6. **The in-house model (Mondapac Intelligence)** joins later as one more provider behind the same
   `ModelProvider` contract, through a versioned HTTP contract: our message format, the model
   version id and token counts in the answer, no text retained, processing in the Market's region,
   authentication by a server-only key or mTLS. Its endpoint address changes only by PR. It is held
   to decision 3 like any other route; before its first shadow request Hassan approves the endpoint
   and the result is added to this ADR. Customer data reaches shadow mode only with the owner's
   written approval.
7. **Data categories** stay those of ADR-0019 decision 3: certificate files and seller texts; for
   the buyer, the customer's own message, order status and tracking. No address, phone or payment
   data. A new category needs the owner's approval, recorded in an amending ADR.
8. **Cost cap.** Caps are counted in US micro-dollars at the catalogue price (never a panel price),
   reserved before a call and settled after it (`docs/design/domain/platform-ai.md` section 7). The
   cap values are admin settings per Market (ADR-0053). Each month the gateway total is compared
   with the provider invoice; a mismatch raises an alert.
9. **Key rotation** needs a server restart (keys are read at boot), not a release. Reload without a
   restart is FE-234.

## Consequences
- Adding a model or a provider is always a PR plus Hassan's check; the panel only chooses among
  approved rows. A cheap or fast new model is not usable on the day it is released.
- The fallback route doubles the contracts to check and the keys to hold, and covers an outage of
  the primary service only, not a fault of the model itself.
- A route whose contract or region cannot be verified keeps AI off in that Market, which R8
  already allows.
- The `ASSISTANT_MODEL_*` variables stay for keys only once G3 moves model ids and prices into the
  catalogue; until then they keep their current meaning.

## Alternatives considered
- **A different provider as fallback:** it covers a model fault too, but needs its own evaluation
  and prompt work for every capability and a second contract review; the owner chose the same model
  on a second route.
- **No fallback for now:** simplest, but every provider outage switches every capability off.
- **Model ids typed in the panel:** one key usually reaches several regions and preview versions,
  so a typed id could send data to a region or version nobody checked (Hassan, design review v3).
- **Prices set in the panel:** a price lower than the real one shrinks the reservation and voids
  the cap.
