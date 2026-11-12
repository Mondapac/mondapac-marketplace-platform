# Product images card screenshots (not part of CI)

Renders the admin `ProductEdit` form with a mocked `/api/` and takes the images card states
(empty, filled with a library-only photo, the tile menu, the delete dialog, full) at 1280, 768
and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/product-images-shots/run.mjs <out-dir>
