# Quick entry table screenshots (not part of CI)

A throwaway page that renders the quick entry table of new drafts and the edit page's Handling
(Offer page PR 5) from mocked data, and takes screenshots at 1280, 768 and 375 px in light and
dark. Run from `apps/seller`:

    VITE_PATH=<path to the vite package> node test/quick-entry-shots/run.mjs <out-dir>

Scenarios: `opened` (as "Sell these" opens it), `typed` (prices typed, one product's stock filled
with "Apply to all sizes", one size out of stock) and `edit` (the edit page with Handling).
