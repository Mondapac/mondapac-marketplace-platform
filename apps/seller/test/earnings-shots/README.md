# Earnings payout list screenshots (not part of CI)

Renders the real `PayoutsList` (super list 33) against a stub API with fixture payouts at 1280, 768
and 375 px in light and dark: the list, the filter panel with chips, the sort panel, the column
picker, the Export dialog, the empty state and the load error. Run from `apps/seller`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright> CHROME_PATH=<chrome> \
      node test/earnings-shots/run.mjs <out-dir>

`?state=empty` and `?state=error` choose the empty and error pages.
