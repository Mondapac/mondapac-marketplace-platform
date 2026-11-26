# config/service-areas

ServiceArea postcode sets as code (ADR-0005 decision 7, ADR-0008): one `<MARKET>.json` per
Market, validated when the API starts. The directory is read by `ServiceAreaDirectory`
(`apps/api/src/platform/market-config/`); a Region Stack refuses to start if a market in
`HOSTED_MARKETS` has no file here, if a file is invalid, or if two areas claim one postcode.

```json
{
  "market": "AU",
  "areas": [
    {
      "code": "greater-brisbane",
      "names": { "en": "Greater Brisbane" },
      "region": "QLD",
      "postcodes": ["4000-4179", "4500"],
      "sellerOnboardingEnabled": false,
      "deliveryEnabled": false
    }
  ]
}
```

- `code`: stable text, `^[a-z0-9][a-z0-9-]{0,63}$`. Other modules store only this code.
- `names`: the area's display names by language tag (`en`, `fa`, `ar`...). English is required;
  other languages are added as they are translated by a person (never machine-translated).
  The admin and the storefront show the name for the reader's language and fall back to `en`.
- `region`: optional. The Market region (state) the area sits in, as the address region field
  writes it ("QLD"). A later cross-area rule can name a whole region and mean all its areas.
- `postcodes`: exact postcodes (ASCII letters and digits) or digit ranges whose ends have the
  same length, low to high. Spaces and case are ignored. A hyphen always means a range, so a
  Market whose postcodes contain a hyphen cannot list them yet; the grammar grows with that
  Market. One area may list overlapping entries; two areas may not. Callers pass `areaFor` a
  postcode already checked against the Market's `postcodePattern` and field length.
- The two flags are independent: where sellers may sign up, and where customers may receive
  orders. Switching one is a configuration change, not code. An area does not own a time
  zone: zones come from addresses (ADR-0005).

The `greater-brisbane` postcode set is a **draft** (Brisbane, Logan, Ipswich, Moreton Bay,
Redland) for the product owner to confirm, and both flags are `false` until the owner opens
the area. Until then every AU address is outside the open areas (fail-closed).

## Outlines on the map (FE-098)

The storefront's Deliver to map draws each area open for delivery from
`config/service-area-boundaries/<MARKET>.json`, built from the official postal-area shapes of
exactly the postcodes listed here (see that folder's README). **After changing an area's
`postcodes`, rebuild it** with `node scripts/service-areas/build-boundaries.mjs <MARKET>`: the API
refuses to start while the outline was built from another postcode list. The outline is a guide;
the postcode decides delivery.

## Cross-area selling (seller city, package 8)

Selling across areas is OFF at launch. A seller serves buyers in its own area only. The
infrastructure to allow more is an optional `crossAreaSelling` section in the same file:

```json
"crossAreaSelling": {
  "enabled": false,
  "lanes": [
    { "from": { "area": "greater-brisbane" }, "to": { "region": "QLD" } },
    { "from": { "region": "NSW" }, "to": { "all": true } }
  ]
}
```

- `enabled` is the Market switch and is `false` when the section or the key is missing. While it
  is off, every lane is ignored.
- A lane says where the seller is (`from`) and where the buyer is (`to`). Each side is one
  `area`, a `region` (every area of that state) or `all`. A lane works in one direction only.
- No matching lane means no cross-area selling (fail-closed). An unknown area, a missing area
  and a lane naming an area or region the file does not list (the API refuses to start) all
  answer no.
- `ServiceAreaDirectory.sellerMayServe(market, sellerArea, buyerArea)` is the one question
  callers ask. Checkout and the storefront do not ask it yet: that is the next step, together
  with the carrier and cost per lane, which this section leaves out on purpose.
