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
      "postcodes": ["4000-4179", "4500"],
      "sellerOnboardingEnabled": false,
      "deliveryEnabled": false
    }
  ]
}
```

- `code`: stable text, `^[a-z0-9][a-z0-9-]{0,63}$`. Other modules store only this code.
- `postcodes`: exact postcodes or digit ranges whose ends have the same length. Spaces and
  case are ignored.
- The two flags are independent: where sellers may sign up, and where customers may receive
  orders. Switching one is a configuration change, not code. An area does not own a time
  zone: zones come from addresses (ADR-0005).

The `greater-brisbane` postcode set is a **draft** (Brisbane, Logan, Ipswich, Moreton Bay,
Redland) for the product owner to confirm, and both flags are `false` until the owner opens
the area. Until then every AU address is outside the open areas (fail-closed).
