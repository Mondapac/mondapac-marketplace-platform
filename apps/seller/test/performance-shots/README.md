# Seller Performance page screenshots (not part of CI)

Renders the seller `Performance` page against a mocked `/api/` in six states (at risk, unhealthy,
Refresh cooling down, a recount waiting, New, and no score yet), at 375, 768 and 1280 px in light and
dark. The page is new, so there is no "before". The panel shell is not drawn. Run from `apps/seller`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/performance-shots/run.mjs <out-dir>
