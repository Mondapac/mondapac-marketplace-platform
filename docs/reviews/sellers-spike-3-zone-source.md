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

## Proposed design (reviewed by Mohammad and Hassan, 2026-10-08; not yet an approved amendment)
This reverses 16.2 item 4 and 7.1a row 9 of `docs/design/domain/sellers.md`, so it is a sellers
mini-review (rule 10) for Ali, Hassan, Mojtaba and Hadi. Nothing in `sellers.md` or the data design
is changed by this PR.

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
is rate limited, audited, and mails the owner; the pointer moves so `approvedSellerZones` answers
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

**GPS pre-fill (Hassan's addendum).** A port `LocationTimezoneResolver` (coordinates to an IANA zone
or none) in `sellers/application/ports`, no-op default; it fails closed (error, timeout or stub
returns none and the form uses the address-derived zone). Coordinates are untrusted: finite numbers
in range, the result still passes the allow-list, the seller still confirms, and the certificate rule
above still applies. Source recorded as `address`, `device` or `seller`. Privacy: our own notice
before the browser prompt, coordinates rounded on the client (about 2 decimals), never stored,
logged, audited, put in events, telemetry or AI input (only the resulting zone is kept); only this
use case may import the port (`pnpm boundaries`); no pre-fill in acting-as; a real provider needs a
vendor and licence review first (Google Maps terms forbid storing a zone derived from their data,
see above).

**Amendments needed (Mohammad).** `sellers.md` 1.1, 2.1, 3.1, 4.1, 4.2, 6.2 (row `correct-timezone`),
6.3, 6.4, 6.5, 7.1a row 9, 7.4, 9, 10, 13.1, 13.2, 16.2 item 4 and the AC 8 and change log; the data
design (revision `kind` gets `zone-change`; a `timezone_source` column; Mojtaba decides); the UX
(S3, S7, D8, F18; a zone picker, Figma first per ADR-0017); `certification.md` 4.2 rule 2 / T2.
Slices: 2 (config, picker, ZZ), 5 (withdraw and reviewer marker), 10 (`zone-change` revision), 8, 17.

**Open (not decided here).** Option B lets a change take effect without a reviewer, which 3.1 removed
at G2 (Ali and Hassan); whether an admin may pick any zone of the Market; the rate-limit numbers
(Hassan); whether open orders keep their cut-off (the `ordering` design); whether
Australia/Lindeman is listed for QLD (Hadi).
