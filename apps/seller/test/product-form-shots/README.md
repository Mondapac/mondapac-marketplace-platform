# Seller product form screenshots (not part of CI)

Renders the seller `EditForm` (one Product card, Status card, Organisation card) with a mocked
`/api/`, at 375, 768 and 1280 px in light and dark. The panel shell is not drawn. Run from
`apps/seller`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/product-form-shots/run.mjs <out-dir>
