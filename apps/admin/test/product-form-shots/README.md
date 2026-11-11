# Product form screenshots (not part of CI)

Renders the admin `ProductEdit` form (Add landing, published with a revision, inactive, the turn-off
dialog and the "Sellers selling it" card) with a mocked `/api/`, at 375, 768 and 1280 px in light and
dark. The panel shell is not drawn, so the sticky unsaved bar sits at the top of the page here.
Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/product-form-shots/run.mjs <out-dir>
