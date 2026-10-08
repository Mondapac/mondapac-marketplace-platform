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
  Slice 2 adds `sessions.customer` (`idleTimeoutMinutes` and `absoluteLifetimeMinutes`, idle at
  most absolute; identity design 6.1), `signInThrottles` (`accountOrigin`, `account`, `origin`)
  and `mailThrottles` (`account`, `origin`), each a `limit`, a `windowMinutes` and a
  `blockMinutes` (0: no block, the window alone refuses; identity design 6.8), and
  `signInRecordRetentionDays` (how long sign-in records are kept; data design 3.6). Slice 3
  adds `links.lifetimeMinutes` (per link purpose; `verify-email` 1 to 1440, 1440 for AU;
  identity design 3.7), `links.targets` (per population, the storefront page of each mail: `verify-email`, where
  the token is appended as the URL fragment, and `sign-in`; an https URL, plain http only for a
  loopback host such as `localhost`, with no fragment and no credentials; the AU hosts are `.test` placeholders until D2),
  `unverifiedAccountRetentionDays` (1 to 30; 7 for AU: an account never verified is deleted
  after this; identity design 3.1, 12.2) and `mail` (`fromAddress` and `fromName`, the sender of
  identity's mail; identity design 9). The mail text itself is in `config/locales/`, in the
  Market's `defaultLocale`. Slice 5 adds `sessions.seller` (the seller side's default session,
  12 hours idle and 24 absolute for AU; identity design 6.1), `keepSignedInSessions.seller`
  ("keep me signed in", opt-in at seller sign-in: 14 days idle and 30 absolute for AU; a
  population absent here is never offered it), `sellerApprovalRequired` (required: `true` makes
  a self-registered seller start `pending` until an admin approves it, `false` makes it start
  `approved`; true for AU; identity design 3.3, SEL-03) and `links.targets.seller` (the seller
  panel's pages, as for the customer). A Market without `sessions.seller` or
  `links.targets.seller` offers no seller sign-up: it answers `access.unavailable`. Later
  identity slices add their values here.
- `allowedOrigins`: the browser origins (`scheme://host[:port]`, no path) that may send a
  request with an unsafe method to this Market (identity design 6.4, HF14). A request whose
  `Origin` header is not listed, or whose `Sec-Fetch-Site` is not `same-origin`, is refused with
  `request.csrf`; a request without either header is not refused by this check. Empty for AU
  until the hosts of the panels are decided (D2).

Tax, payment, carrier, certification-issuer and legal-entity settings are added by the modules
that own them, after their readiness gates (ADR-0013).

## `sellers` section (optional)

Owned by the `sellers` module (`docs/design/domain/sellers.md` 4.1). A Market without it is valid
but cannot take seller addresses. It starts with what slice 2 needs; later slices add the rest of
4.1 here.

- `address`: the `fields` of an address in order (`key`, `labelKey`, `required`, `maxLength` up to
  120), which of them is the `postcodeField` and the optional `regionField`, the
  `postcodePattern` (a regular expression) and the `regions` list. `regionField` and a non-empty
  `regions` go together.
- `timezones`: `byRegion` names an IANA zone for exactly the regions of `address.regions`, and
  `postcodeExceptions` lists postcodes (or same-length digit ranges) whose zone differs from their
  region's. Never an offset (ADR-0005). An entry is an exact postcode (letters and digits, no
  hyphen) or a digit range with ends of equal length, low to high, the same grammar as
  `config/service-areas/`. A Market whose real postcodes contain a hyphen cannot list them yet;
  the grammar grows when such a Market is added. Every exception must also match
  `postcodePattern`, and no postcode may appear in two exceptions.

The AU `postcodeExceptions` list is empty until the zone table of sellers spike 3 (a source whose
licence allows a checked-in file) is done: Broken Hill, Lord Howe Island and Eucla are among the
postcodes it will name. Until then sellers there are outside the open ServiceArea anyway.

`postcodePattern` runs on user input, so it must be anchored with `^` and `$`, at most 64
characters, with no `*`, `+`, lookaround or back-reference and only bounded `{n}` or `{n,m}`
repeats. Field keys and region names must not be `Object.prototype` members. The postcode and
region fields must be required and different, and arrays and strings have size caps. Slice 2
makes `sellers` mandatory for a `soft_launch` or `active` Market when it adds its first reader.
