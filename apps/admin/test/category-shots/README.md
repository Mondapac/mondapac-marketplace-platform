# Category dialog screenshots (not part of CI)

A throwaway page that renders `CategoryPageView` with a mocked `/api/` and takes the dialog
screenshots at 375 px in light and dark. Run from `apps/admin`:

    node test/category-shots/run.mjs <out-dir>

It builds with Vite, serves the build on a local port and drives the pre-installed Chromium.
