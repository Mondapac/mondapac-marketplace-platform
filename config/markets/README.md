# config/markets

Market configuration as code (ADR-0003 decision 5): one `<CODE>.json` file per Market,
validated when the API starts. A Region Stack serves only the Markets listed in its
`HOSTED_MARKETS` variable, and refuses to start if one of them has no file here.

Fields today: `code`, `status` (`planned` | `soft_launch` | `active` | `suspended`),
`defaultLocale`, `supportedLocales`, `defaultCurrency`, `settlementCurrency` and `timezone`.
`timezone` is only a fallback (ADR-0005): sellers, locations and addresses carry their own zone.

- `requestLimits`: the generic per-origin rate limiter (`apps/api/src/platform/rate-limit/`;
  identity design 6.8). `anonymousIdentityPerMinute` (sign-up, sign-in and reset requests;
  20 for AU) and `defaultPerMinute` (every other market-scoped route; 300 for AU). The counter
  of an origin is shared by every Market of the Region Stack; the request's Market chooses
  only the limit.
- `identity`: the identity policy section (identity design 8.5 and 15). `password.minLength`
  (at least 15) and `password.maxLength` (64 to 128), counted in code points after Unicode
  NFKC (identity design 6.5); `existingAccountNoticeHours` (1 to 168; 24 for AU), the least
  time between two "you already have an account" notices to one account (identity design 6.7).
  Later identity slices add their values here.

Tax, payment, carrier, certification-issuer and legal-entity settings are added by the modules
that own them, after their readiness gates (ADR-0013).
