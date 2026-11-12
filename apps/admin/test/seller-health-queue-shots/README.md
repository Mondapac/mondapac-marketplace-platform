# Admin "Sellers that need a look" screenshots (not part of CI)

Renders the admin `HealthQueue` (the page body, without the panel shell): a list with a nameless
store, a truncated list and the empty state, at 375, 768 and 1280 px in light and dark. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/seller-health-queue-shots/run.mjs <out-dir>
