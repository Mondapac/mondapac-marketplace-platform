# Variants page screenshots (not part of CI)

Renders `VariantsView` with a mocked `/api/` and takes the Variant types, swatches, view-only and
Variants screenshots at 1280, 768 and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/variants-shots/run.mjs <out-dir>
