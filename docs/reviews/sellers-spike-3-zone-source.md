# Sellers spike 3: source of the AU postcode-exception zone table (decision record)

**Owner:** Hossein (backend). **Date:** 2026-10-08. **Question:** `sellers.timezones.postcodeExceptions`
of `config/markets/AU.json` (domain design 4.1, `TimezoneResolver`; spike 3 of 11.3) needs the few
postcodes whose time zone differs from their state's (Broken Hill, Lord Howe Island and similar),
from a source whose licence allows a checked-in file.

**Owner's answer (2026-10-08):** use Google Maps as the source; if that is not possible, leave it
to the vendor.

## Finding: Google Maps cannot be the source of a checked-in table
Read from the Google Maps Platform Terms of Service (section numbers as the page shows them) and the
Time Zone API overview, 2026-10-08:

- The Time Zone API takes a latitude/longitude and a timestamp. It does not take a postcode, so a
  table keyed by postcode would first need geocoding every postcode, which is a second API.
- §3.2.3(a)(ii): no bulk download of "geocodes … and time zone details". §3.2.3(a)(i) and (b): no
  pre-fetching, indexing, storing or caching Google Maps Content except as the service-specific
  terms allow. §3.2.3(c): no content created from Google Maps Content.
- A table of postcode to zone built from these answers and committed to the repository is exactly
  that, and so is storing a zone per seller from a live call as a cache.

Not checked: the Maps Service Specific Terms, which may allow a narrow exception, and whether a
legal counsel's reading differs. Hossein is not a lawyer; this is a reading of the public text.

## Decision (within Hossein's scope)
- `postcodeExceptions` of AU stays **empty**. Every AU address gets the zone of its state
  (`byRegion`). Wrong only for the few exception postcodes, which are outside the open ServiceArea
  (`config/service-areas/AU.json`, both flags false) and so cannot onboard today.
- No Google Maps call and no Google-derived data enters the repository.

## Owner's rulings (2026-10-08)
1. First ruling: keep domain design 4.1 (admin corrects), AU `postcodeExceptions` empty.
2. **Superseded the same day:** the owner wants the seller to fix the zone themselves, to leave
   less work for the admin.
3. The owner also wants the zone pre-filled from the user's GPS location; the GPS finder does not
   exist yet, so only the logic and the port are built now, with a no-op default.

Spike 3 itself (a postcode table from a licensed source) is closed: no usable source, and with a
seller-chosen zone the table is not needed (`postcodeExceptions` can be dropped).

## Design (reviewed by Mohammad and Hassan; accepted with changes by the sellers mini-review, 2026-10-08)
This reverses 16.2 item 4 and 7.1a row 9 of `docs/design/domain/sellers.md`, so it was a sellers
mini-review (rule 10) for Ali, Hassan, Mojtaba and Hadi; the result is in "Mini-review result" below.
Nothing in `sellers.md` or the data design is changed by this PR; Mohammad and Mojtaba apply the amendments.

**Rule (Mohammad).** Config 4.1: `timezones.byRegion` becomes, per region, `{ default, selectable[] }`
with `default` in `selectable`, checked against the runtime zone database at boot. The lists come
from tzdb `zone1970.tab` (public domain, so no licence problem), e.g. NSW: Sydney, Broken_Hill,
Lord_Howe; ZZ needs one region with two zones. Saving the address resets the zone to the region's
default when the current zone is not on the new list; the seller may then choose from the list
(`my-file.save-timezone`). The domain invariant `SellerFile.chooseZone(zone, allowed)` holds however
the request arrives: never free text, never an offset, never `Etc/*`. While a revision is pending, a
zone change withdraws it like any reviewed field. An approved revision never changes in place.
After approval (Mohammad's option B): a `zone-change` revision written and approved automatically
in one unit, allowed only when the zone is the only change, is on the list for the approved address's
region and no revision is pending; it needs the 10-minute re-confirmation, is refused in acting-as,
is rate limited, audited, and mails the Seller Owner; the pointer moves so `approvedSellerZones` answers
the new zone at once. An address change also carries a chosen zone.

**Guardrails (Hassan; 1, 2, 3 and 6 block merge).**
1. Allow-list per region from Market config, validated at boot.
2. Before approval the zone is a draft field; after approval it changes only through a revision.
3. Certification evaluates every seller boundary (stored at approval and checked at evaluation)
   against the **earliest** of the chosen zone's and the address-derived zone's boundary, so an
   override can never extend a certificate's validity. The 7.1a read carries both zones (a
   certification mini-review, 4.2 rule 2 and T2).
4. The reviewer sees "zone chosen by seller; address gives X".
5. Audit row `sellers.timezone.changed` (before, after, actor, source, revision id); owner mail.
6. Refused in acting-as; Seller Owner key only.
7. Counts toward the submission limit, plus at most 3 zone changes per 90 days.
8. Not retroactive: orders, tax periods and stored boundaries keep the instants already computed.

**GPS pre-fill (Mohammad's and Hassan's addenda).** Port `LocationTimezoneResolver` in
`modules/sellers/application/ports`, adapters in `sellers/infrastructure`, chosen per Market
(`sellers.locationTimezone.adapter`: default `none`, `fake` in tests). Contract:
`zoneFor(market, { latitude, longitude }) -> IanaZoneId | null`; `null` means no suggestion (the
`none` adapter, invalid coordinates, a point outside the Market, an error or a short fixed timeout);
it never throws into the save path and never returns an offset. The real adapter looks up offline in
a checked-in boundary dataset (no third-party geocoder; Google is ruled out above); the dataset
needs a licence check before it merges (timezone-boundary-builder is ODbL).
- **The address wins.** The GPS zone is only a hint for a draft whose zone no seller or admin has set,
  never after approval, and only if it is on the allow-list of the address's region; otherwise it is
  dropped silently and the region default stays. The domain method takes
  `suggestedZone: IanaZoneId | null` and enforces the rule itself. The seller can still correct it
  from the allowed list (the fallback).
- **Untrusted input.** Coordinates are client-supplied: finite numbers in range, never trusted for
  more than the hint; the certificate rule above still applies. Source recorded as `default`,
  `location`, `seller` or `admin`; the reviewer sees when the final zone differs from the
  address-derived one and who chose it, never coordinates.
- **Privacy.** Our own notice before the browser prompt (wording for the owner and counsel), client
  rounding to about 2 decimals, coordinates live only for the request and are never stored, logged,
  audited, put in events, telemetry or AI input; only this use case may import the port
  (`pnpm boundaries`); no pre-fill in acting-as.
- **When.** Slice 2 builds the port, the `none` and `fake` adapters and the domain rule, tested on AU
  and ZZ, but the HTTP request does not accept coordinates yet (an unused field is attack surface).
  A later small slice ("location hint", tier A, Hassan reviews) adds the real adapter and dataset, the
  optional `location` field on `save-address` and the frontend step (Figma first), once the GPS
  finder exists. Not on the first-sale path.
- **Hint sources by client (owner, 2026-10-08).** The phone apps will use GPS, through the
  `LocationTimezoneResolver` port above, when they are built. On a computer the hint comes from the
  browser: first its own time zone (`Intl` `resolvedOptions().timeZone`: no permission, no dataset, no
  location data, same allow-list and address-wins rules). The owner also named the computer's IP as an
  alternative; an IP lookup is server-side, needs a licensed database (its licence checked like the
  GPS dataset) and a privacy review by Hassan (an IP is personal data; it must not be stored or logged
  for this purpose, and proxies and VPNs make it unreliable). It is therefore not built until the
  browser zone proves insufficient, and the browser zone is the default.

**Amendments needed (Mohammad).** `sellers.md` 1.1, 2.1, 3.1, 4.1, 4.2, 6.2 (row `correct-timezone`),
6.3, 6.4, 6.5, 7.1a row 9, 7.4, 9, 10, 13.1, 13.2, 16.2 item 4 and the AC 8 and change log; the data
design (revision `kind` gets `zone-change`; a `timezone_source` column; Mojtaba decides); the UX
(S3, S7, D8, F18; a zone picker, Figma first per ADR-0017); `certification.md` 4.2 rule 2 / T2.
Slices: 2 (config, picker, ZZ), 5 (withdraw and reviewer marker), 10 (`zone-change` revision), 8, 17.

## Mini-review result (2026-10-08, rule 10)
All four reviewers: **accept with changes**. The changes below are required in the amendments; none was applied to `sellers.md` or the data design by this PR.

**Rulings that replace the "Open" list.**
- **Option B is decided (Ali, with Hassan's conditions).** A post-approval zone change needs no reviewer because a chosen zone can only bring a certificate's expiry forward (guardrail 3). It is a narrow exception to 3.1 (G2). Conditions: Seller Owner only, through the protected `sellers.business-identity.edit` key; the notice goes to the sign-in address, not the contact email; refused in acting-as; the 10-minute re-confirmation. The `zone-change` revision is byte-identical to the previous approved revision except the zone and its source (domain rule plus test), is approved by the rule `zone-change.auto` (never counted as a human review) and inherits its parent's approval facts (so a closed ServiceArea cannot block an existing seller, 7.2 row 2 joins the amendments list).
- **Admins use the same per-region list as sellers (Ali, Hassan).** A zone outside the list goes only through `seller.edit-approved-identity` (reviewed). Each admin choice has source `admin` and is audited.
- **Server-side checks in one unit (Hassan).** The zone-change use case checks "only the zone differs" (content hash), "no revision pending" and "zone on the approved address's region list" against the stored approved revision, in the same unit as the pointer move, with an optimistic version on `SellerFile`; a test covers the race with `request-change`.
- **Boot fails** (not warns) when a listed zone is not a canonical `zone1970.tab` ID (no `backward` links such as `Australia/NSW`), is `Etc/*`, does not belong to the Market, or `default` is not in `selectable`. `chooseZone` compares exact strings and never normalises.
- **Guardrail 3 contract (Hassan, Ali).** `approvedSellerZones` returns `{ zone, addressZone }`; the key-set test and the byte-identical test across caller kinds (7.1a rows 5 and 10, AU and ZZ) cover both; a missing `addressZone` gives `seller-zone-missing`. Certification uses the earliest of: the boundary stored at approval, the chosen zone's and the address zone's boundary. Test: a Sydney-address seller choosing `Australia/Broken_Hill` never gains the 30 minutes. This is a **fixed-contract change**: the certification amendment (4.2 rule 2, T2, ADR-0028 decision 8) must merge **before** any seller-chosen zone can reach an approved revision, that is before sellers slice 2.
- **Hints (Hassan, Ali).** One server-side order: region default, then the browser zone or the GPS zone, only for a draft whose zone nobody has set; then the seller or an admin may change it. All hints are untrusted text (at most 64 characters), pass the region list and the address-wins rule, and are dropped silently otherwise. The browser zone has its own source value `browser`, never `location`. The server rounds coordinates to 2 decimals itself; the later location slice redacts coordinates from request logs, errors and APM, never echoes them in validation errors, and has a canary-coordinate log test. IP lookup stays unbuilt (new privacy review and licence check).
- **Rate limits (Hassan).** Post-approval `zone-change`: 1 per 24 h and 3 per rolling 90 days per seller file, also counted in the 5 per 24 h submission limit, checked inside the unit (Mojtaba: count `zone-change` revisions in the unit under the version lock, no new counter). Draft zone saves: the existing saves limit. Admin corrections: 30 per admin per 24 h. Location or IP lookups (later): 10 per minute and 50 per 24 h per account.
- **Lindeman (Hadi).** QLD is `{ default: Australia/Brisbane, selectable: [Brisbane, Lindeman] }`; the list is whatever `zone1970.tab` gives for the region and the boot check confirms it. A seller who does nothing gets the region default, so "can sell" is never blocked (owner to confirm).
- **Open-order cut-offs** go to the `ordering` design; guardrail 8 is enough for now. A real Broken Hill seller loses 30 minutes of certificate validity; this fails closed and goes in the brief's risks.

**Data design changes (Mojtaba), made in the migration of the slice that first creates each column.** `business_file_revisions.kind` allows `zone-change` and a CHECK keeps it `approved`/`superseded`; a zone-change is a full snapshot; `timezone_source` (`default`, `browser`, `location`, `seller`, `admin`) on `seller_files` (slice 2) and on revisions (slice 5), with CHECKs; a clear `address_timezone` column on both (the address is encrypted and the zero-unwrap rule forbids decrypting it to derive the zone); no column for coordinates, ever; `sellers.timezone.changed` audit row with codes and ids only. Open for Ali, Hassan and Hadi before slice 5's CHECKs: an admin's post-approval correction uses `zone-change` with `author_kind = 'admin'` (Mojtaba's recommendation) or the existing admin `identity-change`.

**Slices (Hadi).** 2a: config `{ default, selectable[] }`, boot check, picker, domain rule, AC 8 (rewritten) on AU and ZZ. 2b: the `LocationTimezoneResolver` port with `none` and `fake` adapters and the `suggestedZone` rule; no coordinates over HTTP yet. The browser pre-fill is part of the UI step (Figma first, ADR-0017). Slice 10 (`zone-change`) comes after the certification amendment. The real GPS adapter is a later tier-A slice (Hassan reviews; ODbL licence check and counsel on the privacy notice).

**Approvals still needed in the amendments:** Hassan on guardrails 1, 2, 3 and 6; Mojtaba on the `kind` and `timezone_source` columns; Hadi on the Lindeman listing, AC 8 and the owner-facing text; the brief change log, brief line 162 (ADR-0005 decisions 1 and 2) and `sellers.md` 19 record the owner's decision of 2026-10-08.
