# In-house model HTTP contract, version 1 (`mondapac-model/1`)

Status: built in AI Gateway G6a. Decision: ADR-0052 decision 6. This document is the one shared
with the partner team that serves Mondapac Intelligence; the platform's own rules for when the
route may be used are in `platform-ai.md` ("Built in G6a").

The contract is the whole interface between the two teams. The platform sends nothing outside it,
and refuses any answer outside it.

## 1. Versions

- The version is named in the request body (`contract`) and in the `mondapac-contract` header. The
  two always match, and the answer names the same version.
- Inside version 1, a side may add new optional fields. The receiver ignores any field it does not
  know, in a request or an answer.
- A new block type, a new `stop` value, a removed or renamed field, or a changed meaning is a new
  version (`mondapac-model/2`). The server answers a version it does not serve with HTTP 404.

## 2. Transport and authentication

| Item | Rule |
| --- | --- |
| Call | `POST <endpoint>/v1/messages`. The platform records `<endpoint>`: an `https://` address on a public DNS host name, with no port, user, query or fragment |
| TLS | HTTPS only. Redirects are not followed: a 3xx answer fails the call |
| Region | The server processes every request in the Market's region (Australia: `ap-southeast-2`) |
| Authentication | `authorization: Bearer <key>`. Each Market has its own key of 32 to 500 characters (`A-Z a-z 0-9 + / = _ -`). To rotate a key, the server accepts the old and the new key for an agreed overlap, then drops the old one |
| Request headers | `content-type: application/json`, `accept: application/json`, `accept-encoding: identity`, `mondapac-contract: mondapac-model/1`, `mondapac-retention: none` |
| Encoding | Request and answer are UTF-8 JSON. The answer is not compressed (no `content-encoding`, or `identity`) |
| Sizes | A request is at most 1 MiB. An answer is at most 1 MiB |
| Time | One call is one model round, with no streaming. The platform waits at most the capability's time limit, then closes the connection. Today the limits are 15 s (buyer chat) and 25 s (description writer), and never more than 120 s. The server should stop work when the connection closes |
| Retention | Neither the request nor the answer is stored, logged with its content, or used for training. `mondapac-retention: none` states this on every call |

## 3. Request body

```json
{
  "contract": "mondapac-model/1",
  "model": "mondapac-intelligence-2026-12-01",
  "system": "Fixed instructions of the capability.",
  "messages": [{ "role": "user", "blocks": [{ "type": "text", "text": "…" }] }],
  "tools": [],
  "maxOutputTokens": 400
}
```

- `model` is the exact model version id the platform recorded for this server. The server answers
  with exactly this version, or answers 404 if it does not serve it.
- `system` is plain text. `maxOutputTokens` is a whole number from 1.
- `messages`:
  - Roles alternate. The first and the last message are `user`.
  - No message has an empty `blocks` list.
  - A block is one of:
    - `{ "type": "text", "text": string }`.
    - `{ "type": "tool-call", "id": string, "name": string, "input": object }`, in `assistant`
      messages only. Every `id` is unique within the request.
    - `{ "type": "tool-result", "callId": string, "content": string, "isError": boolean }`, in
      `user` messages only. Every `tool-call` of an `assistant` message is answered by exactly one
      `tool-result` with the same `callId` in the next `user` message. `content` is data, never
      instructions.
- `tools` lists the tools the model may ask for: `{ "name", "description", "inputSchema" }`, where
  `inputSchema` is a JSON Schema object. It may be empty; then the model asks for no tool.
- Personal data is masked before the request is sent.

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

| Field | Rule |
| --- | --- |
| `contract` | Exactly `mondapac-model/1` |
| `model` | Exactly the requested version id |
| `blocks` | A list of `text` blocks and `tool-call` blocks. A tool call names a tool of the request, has an `id` of 1 to 200 characters that is unique in the answer, and an `input` that is a JSON object valid against that tool's `inputSchema` |
| `stop` | `end` (done), `tool-use` (at least one `tool-call` block, the model waits for the results), `max-tokens` (cut at `maxOutputTokens`; `blocks` may be empty and holds no partial tool call), or `refusal` (the model declines; `blocks` may be empty) |
| `usage` | `inputTokens` counts the system text, the tools and the messages; `outputTokens` counts the answer and is at most `maxOutputTokens`. Both are whole numbers from 0 and both are required |

An answer that breaks any of these rules is refused as a whole, and none of it is used. If
`contract` or `model` differ from the request, the platform counts the server as down for this
call and tries its next route.

The platform checks the model's text again in each feature (schema, safety rules, plain-text
display). The contract does not make the text trusted.

## 5. Errors the server returns

The platform never reads the body of a non-200 answer, so the server should not put request text
in it.

| Situation | Status | What the platform does |
| --- | --- | --- |
| The request is malformed, or too large, for any server | 400, 413 or 422 | Gives up the call; another route would refuse it too |
| Wrong or missing key | 401 or 403 | Tries its next route |
| Unknown contract version or model version | 404 | Tries its next route |
| Too many requests | 429 | Tries its next route |
| Server fault or overload | 5xx | Tries its next route |
| No answer within the time limit | (none) | Tries its next route |

Use 400, 413 and 422 only for a request every route would refuse. A version or key problem answered
with 400 would stop the platform from falling back to its other routes.

## 6. Health check

The platform asks the server, without a model call and without any request text, whether it
serves the recorded model version now. It sends live traffic (the percent and default stages)
only to a server that answered this check well within the last minute; shadow traffic does not
need it.

| Item | Rule |
| --- | --- |
| Call | `GET <endpoint>/v1/health`, no body. About every 30 seconds per Market while the route is in use |
| Headers | `accept: application/json`, `accept-encoding: identity`, `authorization: Bearer <key>` (the Market's key), `mondapac-contract: mondapac-model/1` |
| Answer | HTTP 200, uncompressed UTF-8 JSON of at most 64 KiB: `{ "contract": "mondapac-model/1", "models": ["mondapac-intelligence-2026-12-01"] }` |
| `models` | The model version ids the server serves now for this key, at most 50 |
| Time | The platform waits at most 5 seconds |

```json
{ "contract": "mondapac-model/1", "models": ["mondapac-intelligence-2026-12-01"] }
```

The platform counts the server as healthy for the version only when the status is 200, the body
names this contract and `models` lists the version exactly. Any other answer (another status, a
redirect, a larger or compressed body, another contract, the version missing) or no answer in
time counts as not healthy: live calls then go to the external models. The server may add other
fields; the platform ignores them. The health answer carries no customer data and the platform
keeps only "healthy or not" and the time of the check.
