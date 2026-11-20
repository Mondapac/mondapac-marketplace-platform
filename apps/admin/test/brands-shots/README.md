# Brands page screenshots (not part of CI)

Renders `BrandsView` with a mocked `/api/` and takes the Brands list (Active and Proposed views) at
1280, 768 and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/brands-shots/run.mjs <out-dir>
