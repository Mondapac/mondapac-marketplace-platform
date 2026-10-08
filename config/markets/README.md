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
  population absent here is never offered it) and `links.targets.seller` (the seller
  panel's pages, as for the customer). A Market without `sessions.seller` or
  `links.targets.seller` offers no seller sign-up: it answers `access.unavailable`. Slice 4
  adds `links.lifetimeMinutes.reset-password` (required, and exactly 60 in every Market: SEL-05
  and ACC-04 fix it) and the `reset-password` page in `links.targets.customer` and
  `links.targets.seller` (the page of the reset mail; the token goes into its fragment). The
  reviewer notice (identity design 8.7, request R-3) adds `links.targets.admin` with one page,
  `seller-review-queue`: the admin panel's "Awaiting review" queue, the only link of the
  reviewer notice (a fixed page URL, never a seller id or a query built from data). Each
  population has its own pages, so this page exists only for `admin`. It is required whenever
  `links.targets.seller` is present (boot fails without it), and its origin and host name must
  differ from those of every `seller` and `customer` page (the admin panel is a host of its own;
  another port on the same host is refused too). Later
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
but cannot take seller addresses. It starts with what slices 1 and 2 need; later slices add the rest of
4.1 here.

- `approvalRequired` (required; sellers slice 1): `true` makes a self-registered seller start
  `pending` until an admin approves it, `false` makes it start `approved`; true for AU
  (identity design 3.3, SEL-03). It moved here from `identity.sellerApprovalRequired`, which no
  longer exists. It seeds the ADR-0026 setting `sellers.approval-required`; `identity` and
  `sellers` both read it from this path. A Market with no `sellers` section gets the safe value
  `true` from both.
- `address`: the `fields` of an address in order (`key`, `labelKey`, `required`, `maxLength` up to
  120), which of them is the `postcodeField` and the optional `regionField`, the
  `postcodePattern` (a regular expression) and the `regions` list. `regionField` and a non-empty
  `regions` go together.
- `timezones`: `countries` lists the ISO 3166-1 countries whose zones the Market may use (the
  Market code is not always a country); `byRegion` names, for exactly the regions of
  `address.regions`, a `default` IANA zone (the zone a saved address starts with) and the closed
  `selectable` list the seller may choose from; `default` is one of `selectable`. Boot fails when a
  zone is not in the runtime's `Intl` zone list (which refuses `Etc/*`, offsets, abbreviations and
  most `backward` links such as `Australia/NSW`), when it belongs to none of `countries`
  (`Intl.Locale.getTimeZones`, so `Asia/Tokyo` cannot be listed for an Australian region), or when
  a list repeats a zone. The list is in ICU's spelling, which is not always tzdb's (`Asia/Calcutta`
  rather than `Asia/Kolkata` on Node 24): a Market whose zones differ between the two needs a look
  when the runtime moves. Never an offset (ADR-0005). The seller chooses within the list (sellers
  spike 3 record, mini-review 2026-10-08); there is no postcode-exception table and no
  Google-derived data. The lists are reviewed like any config change.
- `reservedWords` (required; sellers slice 2b): `slugs` are whole shop slugs that are never held (site
  routes, platform names) and `claimWords` are the words a seller may not claim (certification
  words and the platform's own name). A `slugs` entry is lower-case letters, digits and single
  hyphens; a `claimWords` entry is lower-case letters only (no digit or hyphen, because it is
  compared with folded tokens), at least one entry, none repeated, each at most 50 characters. In a
  slug a claim word as a hyphen-separated token makes it `slug.reserved`. In a store name the
  name is split on anything that is not a letter or digit and each token is folded (accents,
  look-alike letters and digits) before the comparison, and a claim word of five letters or more is also looked for inside the joined tokens (`HalalMart`); a hit is a reviewer flag that also
  blocks the automatic approval. The lists are Market data, not literals in `sellers`' code
  (sellers design 3.5, Ali change 3); the claim group moves to a `certification` port later.

## `inventory` section (optional)

Owned by the `inventory` module (`docs/design/domain/inventory.md` 8). The module checks at
start-up that every hosted Market has it; the schema keeps it optional so a Market that does not
host inventory yet still loads. It starts with what slice 1 needs; later slices add the
reservation duration, the default low-stock threshold and the default per-customer cap.

- `maxSourcesPerSeller` (required, 1 to 4; 4 for AU): the most sources a seller may have, the
  Default included (inventory design 3.4). The ceiling of 4 keeps the re-key of a moved Offer
  (design 3.6) under the lock helper's 1,000-item cap with 100 variants per product (800 items
  plus held ones); raising it is a design change with a re-check.
