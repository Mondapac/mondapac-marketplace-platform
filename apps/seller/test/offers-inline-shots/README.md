# Offer list inline editing screenshots (not part of CI)

A throwaway page that renders the seller Offer list with its price and stock cells (Offer page
PR 8) from mocked API answers, and takes screenshots at 1280, 768 and 375 px in light and dark.
Run from `apps/seller`:

    VITE_PATH=<path to the vite package> node test/offers-inline-shots/run.mjs <out-dir>

Scenarios: `list` (as loaded), `typed` (a price and a stock typed: the save bar), `sizes` (an
Offer's sizes opened under its row, one price typed) and `locations` (a one-size Offer kept at
two locations, opened).
