# Offer review queue, screenshots (not part of CI)

Renders the Offer review screens (queue tabs, decision drawer, bulk dialogs, seller panel, category
flags, stop banner) with a mocked `/api/` (`?view=first|edits|seller|categories|banner`) and takes
them at 1280 and 375 px in light and dark. Run from `apps/admin` with Playwright and the `vite`
package folder at hand:

    VITE_PATH=<vite package folder> PW_PATH=<folder holding playwright> node test/offer-review-shots/run.mjs <out-dir>

`ONLY=<view>` takes one view.
