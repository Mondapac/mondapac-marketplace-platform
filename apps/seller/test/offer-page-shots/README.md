# One-page offer screenshots (not part of CI)

A throwaway page that renders the offer header, "Your offer" and the sizes table with Details
(Offer page PR 3, and "You receive (est.)" of PR 4) from mocked data, and takes screenshots at 1280, 768 and 375 px in light and
dark. Run from `apps/seller`:

    VITE_PATH=<path to the vite package> node test/offer-page-shots/run.mjs <out-dir>

Scenarios: `closed`, `price` (Details of 500 g, Price tab), `stock` (Stock tab) and `draft` (a
typed price kept and named in Details), `special-new` (a special typed in the Price tab, PR 6)
and `special-error` (Save with a special that has no end), `cost-hidden`, `cost`, `cost-loss` and
`cost-error` (the private Cost tab of 500 g, PR 7-UI). `SHOTS_SCENARIOS=cost,cost-loss` runs only
those.
`typical`, `typical-high` and `typical-low` (Typical price of 500 g, PR 9-UI).
