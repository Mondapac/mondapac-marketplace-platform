# Content page editor screenshots (not part of CI)

Renders the Content and Settings tabs of the page editor (a landing page, a system page, a
read-only page, the module dialogs and their refusals) with a mocked `/api/` at 1280, 768 and
375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/content-editor-shots/run.mjs <out-dir>
