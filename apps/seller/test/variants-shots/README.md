# Variants table screenshots (not part of CI)

A throwaway page that renders `VariantsTable` (SKU and Selling columns, "Sizes you sell") with
mocked data and a mocked `/api/`, and takes screenshots at 1280, 768 and 375 px in light and dark.
Run from `apps/seller`:

    VITE_PATH=<path to the vite package> node test/variants-shots/run.mjs <out-dir>

It builds with Vite, serves the build on a local port and drives the pre-installed Chromium.
Scenarios: `seller` (own product), `platform` (with "Sizes you sell") and `taken` (a SKU the server
refuses with `offer.sku-taken`).
