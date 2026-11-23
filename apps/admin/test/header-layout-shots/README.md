# Page header layout, screenshots (not part of CI)

Renders the page's `PageHeader` over the admin Products list with a mocked `/api/` and takes the
page at 1280, 768 and 375 px in light and dark: the title and Bulk action share one row, with no
count line under the title. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<folder holding playwright> node test/header-layout-shots/run.mjs <out-dir>
