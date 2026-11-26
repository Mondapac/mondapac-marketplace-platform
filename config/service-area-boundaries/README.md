# config/service-area-boundaries

The outline of each ServiceArea (config/service-areas), drawn by the storefront's Deliver to map
(FE-098). One `<MARKET>.json` per Market, generated, never edited by hand:

```
node scripts/service-areas/build-boundaries.mjs AU
```

The script reads the area's `postcodes`, fetches the official postal-area shapes of exactly those
postcodes, joins them into one outline (shared borders dropped), simplifies it to about 100 m,
drops islands under about 1 km², and writes the file with the postcode list it was built from.

- **Source (AU):** Australian Bureau of Statistics, ASGS Edition 3 (2021) Postal Areas (POA),
  licensed CC BY 4.0. The credit ("Based on Australian Bureau of Statistics data, CC BY 4.0") is
  shown in the map's attribution. A postal area (POA) is the ABS's approximation of a postcode;
  rivers and bays belong to no postal area, so the outline follows their banks.
- **Checks at API start-up:** the file is valid GeoJSON MultiPolygon in WGS 84, names only areas
  the Market lists, carries the same `postcodes` as the area does now, and has at most 20 000
  points. Otherwise the API refuses to start (rebuild the file).
- **What is public:** only areas open for delivery are served (`GET shipping/delivery-area-map`,
  anonymous): code, names and outline. No seller or address data is involved.
- A Market without a file simply shows no outline. `SERVICE_AREA_BOUNDARY_DIR` points the API
  at another folder.
