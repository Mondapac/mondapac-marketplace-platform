# Payouts list screenshots (not part of CI)

Renders the real `PayoutsList` (super list 21) against a stub API with fixture payouts at 1280,
768 and 375 px in light and dark, plus the Hold payouts… dialog (level 3). Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/payouts-shots/run.mjs <out-dir>
