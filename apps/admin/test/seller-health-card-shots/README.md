# Admin seller health card screenshots (not part of CI)

Renders the admin `SellerHealthCard` against a mocked `/api/`: at risk, healthy, needs attention,
new seller, not measured yet, and after "Recalculate now" (queued, already queued, failed), at 375,
768 and 1280 px in light and dark. The panel shell is not drawn. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/seller-health-card-shots/run.mjs <out-dir>
