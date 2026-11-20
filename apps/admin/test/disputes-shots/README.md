# Disputes list screenshots (not part of CI)

Renders the real `DisputesList` (super list 23) against a stub API with fixture cases at 1280,
768 and 375 px in light and dark, plus the filter panel. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/disputes-shots/run.mjs <out-dir>
