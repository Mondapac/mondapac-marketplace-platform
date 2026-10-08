# ADR-0037: Trusted Client Address from the BFF Servers

**Status:** Accepted — 2026-10-08 (Ali, cto), on the design review of Hassan (security-tester,
APPROVE-WITH-CONDITIONS 1 to 8, written in). Hassan must still confirm the implementation (PR c)
before it merges. Kazem (devops-engineer) sets the values of decisions 4 and 9 and the secret
store in the deployment slice.
**Amends:** ADR-0034 decision 3 (the "Client address" rule), ADR-0015 decision 3 (the
trust-proxy part of the "Baseline HTTP hardening" row).
**Relates to:** ADR-0003 (Region Stack), ADR-0005 (Clock), ADR-0018, ADR-0020 decisions 3 and 8
(`x-market-id`, correlation id), ADR-0026 (what Market settings may hold),
`docs/design/domain/identity.md` 6.7 (Hassan I4) and 6.8, `docs/design/domain/platform-foundations.md`
section 7 item 6.

## Context
The API keys its per-origin throttles on the client address: the generic rate limiter,
`sign-in.origin`, `mail.origin`, the sellers identifier-lookup quota, and the address stored on a
sign-in record (identity 6.8, HF3). Today that address is the socket peer only: `trust proxy` is
off and `X-Forwarded-For`, `Forwarded` and `X-Real-IP` are ignored (PF 7 item 6, identity I4).

ADR-0034 decision 3 puts a Next.js server (the BFF) in front of the API for each panel, and the
storefront follows the same pattern. Behind a BFF every browser arrives from the BFF's socket,
so every user of a panel would share one origin bucket: one attacker locks everyone out of
sign-in, and the per-origin limits stop limiting anyone. ADR-0034 made the fix a gate for the
sign-in slice and left the mechanism open. A forwarded header alone cannot be the fix: anything
that reaches the API could send one, and a hop count needs deployment facts that do not exist yet.

## Decision
1. **Two factors, both required.** The API accepts a client address from a BFF only when the
   request (a) comes from a socket inside a pinned list of BFF networks and (b) carries a fresh
   HMAC proof under a key that is bound to that network. A pinned list alone admits any neighbour
   on a shared subnet or pod network; a key alone works from anywhere once it leaks. mTLS can
   replace the pinned list later (deployment slice). `trust proxy` stays `false` and the forwarded
   headers stay ignored everywhere. Residual risk, accepted by Hassan: a compromised BFF can claim
   any address, so it can bypass or redirect the per-origin throttles; the per-account counters
   still hold.
2. **The header.** One request header, set only by the BFF:
   ```
   x-client-address: v1;k=<keyId>;t=<unix-seconds>;a=<address>;s=<signature>
   ```
   - `keyId`: `[a-z0-9-]{1,32}`, one per BFF and key generation (`panel`, `storefront`, `panel-2`).
   - `t`: the signing instant in whole Unix seconds (decimal, no sign).
   - `a`: exactly one IPv4 or IPv6 address in text form. A comma, a zone index (`%`), a port or
     brackets are refused.
   - `s`: HMAC-SHA-256 under the key's secret, base64url without padding (43 characters), over
     the UTF-8 bytes of `v1\n<keyId>\n<t>\n<a>\n<x-market-id>`, where `<x-market-id>` is the
     request's `x-market-id` header exactly as sent. Binding the Market means a proof made for
     one Market is refused for another.
   - After it is accepted, `a` goes through the existing `clientAddressOf` and `clientOriginOf`,
     so IPv4-mapped addresses and the IPv6 /64 rule are unchanged.
3. **Resolution and refusals.** A middleware in `apps/api/src/platform/http/client-address.ts`
   resolves the address once per request, before the body parser, Nest's guards and every
   controller, and is the only code that reads the socket's `remoteAddress` (a lint rule enforces
   it). Every refusal answers `400 { statusCode: 400, code: "client-address.untrusted" }` and
   never falls back to the socket.

   | Situation | Result |
   |---|---|
   | Feature off (decision 4), no header | The socket address, exactly as before this ADR |
   | Feature off, header present | Refused (`disabled`): a BFF that signs while the API does not verify must fail loudly, not share a bucket |
   | Feature on, socket outside `TRUSTED_BFF_CIDRS`, no header | The socket address, as today |
   | Feature on, socket outside `TRUSTED_BFF_CIDRS`, header present | Refused (`source-untrusted`) |
   | Socket inside the list, no header | Refused (`missing`): otherwise every panel user silently shares one bucket |
   | Header repeated | Refused (`repeated`) |
   | Header does not match the format of decision 2, or `a` is not one address | Refused (`malformed`) |
   | `x-market-id` absent or repeated while the header is present | Refused (`market-missing`) |
   | Unknown keyId | Refused (`key-unknown`) |
   | Known keyId, socket outside that key's own CIDRs | Refused (`key-source-mismatch`) |
   | `t` more than 60 s before or after the injected Clock's now | Refused (`stale`) |
   | Signature does not match | Refused (`signature-invalid`) |
   | All checks pass | `a` is the client address |

   Order of checks: source and format, then the keyId and its CIDR binding, then the timestamp,
   and only then the HMAC. The signature is compared with `crypto.timingSafeEqual` after a length
   check. The Clock is the injected kernel Clock (ADR-0005), never `Date.now()`. No nonce: a replay
   inside the window must already come from a pinned BFF socket and can at most charge requests
   to the address in the proof (Hassan: Low).
4. **Configuration: deployment environment, never Market configuration.** Trust between processes
   belongs to the Region Stack (ADR-0003); keys are secrets and never sit in admin-editable Market
   settings (ADR-0026).
   - `TRUSTED_BFF_CIDRS`: comma-separated CIDRs, the networks any BFF may send from.
   - `CLIENT_ADDRESS_KEYS`: entries separated by `;`, each `keyId:cidrs:base64`. `cidrs` is a
     comma-separated list of the networks this key is valid from (the panel key only from panel
     hosts, the storefront key only from storefront hosts); `base64` is the secret in standard
     base64, at least 32 bytes. The keyId is the text before the first `:`, the secret the text
     after the last `:`, so IPv6 CIDRs need no escaping. Example:
     `panel:10.20.1.0/24,fd00:20:1::/64:<base64>;storefront:10.20.2.0/24:<base64>`.
   - Both empty or unset: the feature is off and behaviour is exactly as before this ADR (apart
     from the `disabled` refusal of decision 3). This is the default in `.env.example`.
   - Rotation: deploy a new keyId next to the old one, move the BFF to it, then remove the old
     entry. Each BFF has its own keyId so one can be revoked alone.
   - Real values live in Kazem's secret store for each Region Stack.
5. **Start-up refusals.** The process refuses to start (the configuration error names the entry
   by keyId or position, never a secret) when:
   - `TRUSTED_BFF_CIDRS` is set and `CLIENT_ADDRESS_KEYS` is empty, or the reverse;
   - a CIDR is malformed, has no prefix, has host bits set, is an IPv4-mapped IPv6 range, or is
     wider than /16 (IPv4) or /48 (IPv6); `0.0.0.0/0` and `::/0` are named in the message;
   - a key entry is malformed, has no CIDR, or has a CIDR outside `TRUSTED_BFF_CIDRS`;
   - two entries share a keyId, or two keyIds share one secret;
   - a secret is not valid standard base64, or is shorter than 32 bytes.
6. **Health is exempt.** Requests whose path is exactly `/health` or `/health/ready` (the platform
   probes, `@NoMarketContext()`) skip the middleware, so a kubelet or node probe from inside a
   pinned network is not refused. Nothing on those routes reads the client address. The worker
   serves no HTTP and is not affected.
7. **Logging.** A refusal logs one warning with the reason code, the keyId only when it names a
   configured key, and the correlation id. The address, `s`, the header, `x-market-id` and any key
   are never logged; request headers are already never logged (ADR-0020, slice 0 item 5).
8. **Readers.** Every reader of the client address (the rate limiter, `client-origin.ts`, the six
   identity presentation files and the sellers `my-file.controller.ts`) reads the resolved address
   through one function of `client-address.ts`. A request that did not pass the middleware has no
   resolved address, which every reader already treats as "cannot be evaluated" (fail closed,
   `access.unavailable`). An ESLint rule forbids `remoteAddress` member access anywhere in
   `apps/api/src` except `client-address.ts`. OpenAPI documents the optional `x-client-address`
   header and its 400 on every market-scoped operation.
9. **The BFF side (frontend slice, both panels and the storefront).**
   - One signer in a shared package marked `server-only`, used by every BFF and tested against
     the vectors below. Each BFF holds only its own keyId and secret in server environment
     variables, never `NEXT_PUBLIC_*`.
   - It signs in route handlers, server actions and the decision 4 server-component reads of
     ADR-0034; it always drops an incoming `x-client-address` and sets its own, as it does for
     `x-market-id`; a test proves a browser-sent value is overwritten.
   - **Where the BFF gets the browser's address.** A Next.js route handler cannot see its socket
     peer, and Next keeps a browser-sent `X-Forwarded-For`. Each BFF therefore runs behind
     `apps/<app>/server.mjs`: a plain `http.createServer` (HTTP/1.1 only, no h2c) that both `dev`
     and `start` use; `next dev` and the standalone `server.js` are never used. On every request
     (never cached per connection) and before Next sees it, the wrapper deletes `x-forwarded-for`,
     `forwarded`, `x-real-ip`, `x-client-address`, `x-mp-client-address` and the configured edge
     header (after reading it), in any letter case and every repeat in `rawHeaders`, then sets
     `x-mp-client-address`. `CLIENT_ADDRESS_SOURCE` (`socket` | `edge`, required, no default)
     chooses the value:
     - `socket`: the socket peer. Behind a load balancer the worst case is a shared bucket,
       never a forged address. This is the mode until the deployment slice sets `edge`.
     - `edge`: when the socket peer is inside `EDGE_CIDRS`, the value of the single header named
       by `EDGE_CLIENT_ADDRESS_HEADER`; otherwise the socket peer. From a peer inside
       `EDGE_CIDRS`, an absent, repeated or comma-joined value, or one that is not exactly one
       address (`net.isIP`; a zone index, port or brackets are refused), gets
       `400 { statusCode: 400, code: "client-address.untrusted" }` with no fallback.
       `X-Forwarded-For` and `Forwarded` cannot be the edge header; a hop count on them needs an
       amendment to this ADR (deployment slice, spike 5).

     The signer reads only `x-mp-client-address` and refuses to sign (5xx) without it. The BFF
     refuses to start when `CLIENT_ADDRESS_SOURCE` is missing or invalid; with `socket` and
     either edge variable set; with `edge` and either edge variable empty; when `EDGE_CIDRS`
     breaks a decision 5 CIDR rule; or when the header name is not a valid lowercase token or is
     `x-forwarded-for`, `forwarded`, `x-client-address`, `x-mp-client-address` or `x-market-id`.
     Tests in the frontend slice: spoofed headers (mixed case, repeated, `Forwarded`,
     `X-Real-IP`, both internal names) never reach a handler; two keep-alive requests with
     different edge values; edge peer inside and outside the ranges and every malformed case;
     signer refusal without `x-mp-client-address`; every start-up refusal; `dev` and `start` run
     the wrapper; an IPv6 peer; the three vectors.
   - **BFF environment variables** (server only, never `NEXT_PUBLIC_*`; documented in each app's
     own `.env.example` by the frontend slice):

     | Variable | Value | Start-up rule |
     |---|---|---|
     | `CLIENT_ADDRESS_SOURCE` | `socket` or `edge` | Required, no default; anything else refuses to start. |
     | `EDGE_CIDRS` | Comma-separated CIDRs | `socket`: must be empty. `edge`: required; every decision 5 CIDR rule applies. |
     | `EDGE_CLIENT_ADDRESS_HEADER` | One lowercase header name | `socket`: must be empty. `edge`: required; the names listed above are refused. |
     | `BFF_CLIENT_ADDRESS_KEY_ID` | `[a-z0-9-]{1,32}` | Set together with the secret; only one of the two set refuses to start. |
     | `BFF_CLIENT_ADDRESS_SECRET` | Standard base64, at least 32 bytes | Same pairing rule; invalid or too short refuses to start, and the error never shows the value. |

     With both key variables empty the signer sends no `x-client-address`, which matches the API's
     off default (decision 4). `EDGE_XFF_TRUSTED_HOPS` is not defined. Clock synchronisation for
     the ±60 s window (NTP or chrony) is a deployment runbook item (Kazem), not part of this ADR.
10. **Amendments.** ADR-0034 decision 3 "Client address": the header and its trust are those of
    this ADR (an HMAC proof plus a pinned network, not a trust-proxy hop count on the API).
    ADR-0015 decision 3, "Baseline HTTP hardening" row: `trust proxy` stays off on the API; the
    client address behind a BFF comes from this ADR, and a hop count applies only to the BFF's own
    edge (decision 9). Identity 6.8's Origin row now says the client address is "the socket
    address, or the address a BFF proves under ADR-0037".

### Test vectors
The signer and the verifier must both reproduce these (computed with Node's
`crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64url')`).

| Field | Vector 1 | Vector 2 | Vector 3 |
|---|---|---|---|
| keyId | `panel` | `panel` | `storefront` |
| secret (base64) | `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` (bytes 0x00 to 0x1f) | same as vector 1 | `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=` (bytes 0x20 to 0x3f) |
| `t` | `1791417600` (2026-10-08T00:00:00Z) | `1791417600` | `1791417600` |
| `a` | `203.0.113.7` | `203.0.113.7` | `2001:db8:1:2::7` |
| `x-market-id` | `AU` | `ZZ` | `AU` |
| `s` | `VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8` | `pdOR9xvYNH2KymwMOqkRAQiXndUffaIm8am5eyQTMjg` | `b9XsWAV8xLo3H9Nark3wE-d0f01UHm4BaeIkOWnGkPE` |

Vector 1 as a header: `x-client-address: v1;k=panel;t=1791417600;a=203.0.113.7;s=VBHNrLXY_bKDvCMXHp-hfnqKb98sQZ90DnvOVDTYIj8`.
Vectors 1 and 2 differ only in the Market: vector 1's header sent with `x-market-id: ZZ` is refused.

## Consequences
- Delivered as (a) this ADR; (b) shared files `.env.example` and the ESLint rule, announced on
  the board; (c) one atomic backend slice (config, middleware, rate limiter, six identity
  controllers, sellers reader, tests). Hassan's review and QC are mandatory on (c).
- Two browsers behind one BFF get separate origin buckets; ADR-0034's sign-in gate is met on the
  API side (Hassan's N5 and the API side of I4). The edge-to-BFF hop runs in `socket` mode
  (shared bucket at worst, never forged) until the deployment slice sets `edge` (decision 9).
- The seller panel's start-up tripwire (`assertClientAddressForwarding`, ADR-0034 "Known interim
  deviations") stays until the frontend PR that adopts the signer of decision 9, with a test that
  the header is sent; the API side alone does not lift it.
- With the environment empty, nothing changes for any client that does not send the new header.
- A BFF misconfiguration is loud (400 on every relayed request), never a silent shared bucket.
- A compromised BFF host can claim any address; per-account counters remain the backstop.
- Two more deployment secrets per Region Stack, with rotation by keyId.
- The BFFs must keep their clocks within 60 s of the API's.

## Alternatives considered
- **`trust proxy` with a hop count on the API:** trusts whatever header the nearest hop sends and
  needs the deployment facts we do not have; anything inside the network could forge it.
- **Pinned networks only:** neighbours on a shared subnet, and everything in local development,
  pass.
- **HMAC only:** a leaked key works from anywhere.
- **mTLS between BFF and API:** the strongest option, but it needs certificate infrastructure from
  the deployment slice; it can replace the pinned list later without changing the header.
- **A nonce against replay:** needs shared state across API instances for a Low-impact risk.
