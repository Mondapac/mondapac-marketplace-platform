# In-house model HTTP contract, version 1 (`mondapac-model/1`)

Status: built in AI Gateway G6a (adapter `apps/api/src/platform/ai/in-house-http.provider.ts`).
Decision: ADR-0052 decision 6. Parent design: `platform-ai.md` (sections 6 and 8).

This is the contract the partner team's server for Mondapac Intelligence implements, so the AI
Gateway can call it like any other route. It is the whole interface between the two teams: the
gateway never sends anything outside it, and an answer outside it is refused. A change that a
version-1 client cannot read is version 2, with its own adapter, never an edit of this file.

## 1. Who calls whom

- Only the platform API (`platform/ai`, through the AI Gateway) calls the endpoint, server to
  server. No browser, panel or other module reaches it.
- The endpoint address is a row of the route catalogue (`platform/ai/catalogue/in-house.ts`), so it
  changes only by PR with Hassan's (security) review. The panel never shows or edits it.
- One call is one model round (no streaming). The gateway sets the timeout per capability and cuts
  the call at it; the server should stop work when the connection closes.

## 2. Transport and authentication

| Item | Rule |
| --- | --- |
| Address | `POST <endpoint>/v1/messages`; `<endpoint>` is an `https://` address on a DNS host name, no port, user, query or fragment |
| TLS | HTTPS only; redirects are never followed (a 3xx fails the call) |
| Region | The server processes in the Market's region (for AU, `ap-southeast-2`), recorded in the catalogue row |
| Authentication | `authorization: Bearer <key>`; one key per Market, at least 32 characters, held in the platform's secret store as `AI_IN_HOUSE_API_KEY` (Kazem) and checked by the server. mTLS is a later option (FE-20261126-ai-gateway-in-house-mtls) |
| Headers sent | `content-type: application/json`, `accept: application/json`, `mondapac-contract: mondapac-model/1`, `mondapac-retention: none` |
| Retention | Neither the request nor the answer is stored or logged by the server, and neither is used for training (ADR-0052 decision 3). `mondapac-retention: none` states this on every call; Hassan checks it before the row is usable |

## 3. Request body

```json
{
  "contract": "mondapac-model/1",
  "model": "mondapac-intelligence-2026-12-01",
  "system": "Fixed instructions of the capability.",
  "messages": [
    { "role": "user", "blocks": [{ "type": "text", "text": "…" }] }
  ],
  "tools": [],
  "maxOutputTokens": 400
}
```

- `model` is the exact model version id from the catalogue row. The evaluation pass and the price
  are bound to it.
- `messages` alternate `user` and `assistant`. A block is one of:
  - `{ "type": "text", "text": string }`
  - `{ "type": "tool-call", "id": string, "name": string, "input": any }` (assistant turns only)
  - `{ "type": "tool-result", "callId": string, "content": string, "isError": boolean }` (user
    turns only; the content is data built by the platform, never instructions)
- `tools` lists the read-only tools the model may ask for: `{ "name", "description",
  "inputSchema" }` (JSON Schema). Shadow mode sends only capabilities without tools.
- Personal data is already masked by the gateway before the request is built.

## 4. Answer body (HTTP 200)

```json
{
  "contract": "mondapac-model/1",
  "model": "mondapac-intelligence-2026-12-01",
  "blocks": [{ "type": "text", "text": "…" }],
  "stop": "end",
  "usage": { "inputTokens": 812, "outputTokens": 96 }
}
```

| Field | Rule; otherwise the gateway refuses the whole answer |
| --- | --- |
| `contract` | Exactly `mondapac-model/1`; otherwise the route counts as down (`route`) |
| `model` | Exactly the requested version id; otherwise the route counts as down (`route`), so a call is never served by an unevaluated version |
| `blocks` | A list of `text` blocks and `tool-call` blocks; a tool call names a tool of the request and has an `id` of 1 to 200 characters. Any other block type is a server fault (`server`) |
| `stop` | `end`, `tool-use` (then at least one `tool-call` block), `max-tokens` or `refusal` |
| `usage` | `inputTokens` and `outputTokens`, whole numbers from 0, both required: the call is counted at the catalogue price from them |
| Size | At most 1 MiB; a larger body is a server fault and is not parsed |

The model's text is checked again by the capability (schema, claim guard, inert rendering, R1 and
R9); the contract does not make it trusted.

## 5. Errors

The gateway never reads the body of a non-200 answer (it could echo the request).

| Status | Meaning for the gateway |
| --- | --- |
| 429 | Rate limited: the next route is tried |
| 5xx | Server fault: the next route is tried |
| 400, 413, 422 | The request cannot be taken: not retried on another route |
| 401, 403, 404, other | The route refuses its key or does not serve the model: the next route is tried |
| No answer before the timeout | Timeout: the next route is tried |

## 6. What makes the route usable

A catalogue row of the in-house model is usable only when all of these hold (ADR-0052 decision 3,
ADR-0053 decision 3); until then every stage stays off:

1. The row is added by PR: endpoint, region, exact model version id, the price the platform counts it
   at, retirement day if any.
2. Hassan records his check of no retention, no training and the region in the row (`dataTerms`)
   and in ADR-0052's verification log.
3. Kazem puts the Market's key in the secret store.
4. The model version has a recorded evaluation pass for the capability (PR to
   `evaluations/results.ts`).
5. For shadow with customer data: the owner's written approval is recorded in ADR-0052.

The in-house model is never one of the External models tab's choices; only its own stages (off,
shadow, percent, default; G6b to G6e) route to it.
