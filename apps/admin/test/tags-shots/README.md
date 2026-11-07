# Tags page screenshots (not part of CI)

Renders `TagsView` with a mocked `/api/` and takes the list, the edit dialog (two languages) and
the new-tag dialog with its checks at 1280, 768 and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/tags-shots/run.mjs <out-dir>
