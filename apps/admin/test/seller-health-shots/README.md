# Admin seller list Health column screenshots (not part of CI)

Renders the admin `SellersList` on the Approved tab against a mocked `/api/`: before the Health
column (`before`), with it (band and score, New, No data, not measured yet) and when the page's
health could not be read (`unavailable`), at 375, 768 and 1280 px in light and dark. The panel shell
is not drawn. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/seller-health-shots/run.mjs <out-dir>
