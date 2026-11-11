# Content pages screenshots (not part of CI)

Renders the Pages list (all states) and the New page form with a mocked `/api/` at 1280, 768 and
375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/content-pages-shots/run.mjs <out-dir>
