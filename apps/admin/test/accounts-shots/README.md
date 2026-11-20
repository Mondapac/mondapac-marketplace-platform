# Seller accounts list screenshots (not part of CI)

Renders the real `AccountsList` (super list 22) against a stub API with fixture accounts at 1280,
768 and 375 px in light and dark, plus the filter panel. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/accounts-shots/run.mjs <out-dir>
