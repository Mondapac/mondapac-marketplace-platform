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

## Owner's ruling (2026-10-08)
The owner chose option 1 ("go with your suggestion"): keep domain design 4.1 as it is. The seller
sees the zone, an admin corrects it (`seller.correct-timezone`, audited), no new code, and the AU
`postcodeExceptions` table stays empty. Options 2 (seller picks a zone) and 3 (a licence-clean
public list) are not taken; they come back only if a real seller sits in an exception postcode.
Spike 3 is closed on that basis.
