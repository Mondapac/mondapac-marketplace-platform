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

## Open for Mohammad, Hassan and Hadi (not decided here)
"Leave it to the vendor" means a seller chooses the zone. Domain design 4.1 says today that the seller
sees the zone and only an admin corrects it (`seller.correct-timezone`, audited; 7.1a row 9). The
zone feeds cut-offs and `approvedSellerZones` for certification, so a seller-set zone is a design
and security change. Options:
1. Keep the design: state zone by default, admin corrects an exception seller (works today, no code).
2. A seller picks from the zones the Market lists for the state (a design amendment: new field
   error rules, audit, a Hassan check on `approvedSellerZones` evidence).
3. A licence-clean public list of exception postcodes (counsel or Hadi to name one) filled into
   the file.
Recommendation: option 1 until a real seller sits in an exception area; then 3 if a source
exists, else 2.
