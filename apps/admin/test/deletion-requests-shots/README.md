# Deletion requests list screenshots (not part of CI)

Renders the real `RequestsList` (super list 25) against a stub API with fixture requests at 1280,
768 and 375 px in light and dark, plus the filter panel, the row Actions menu and the Cancel
request dialog (empty and filled). Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/deletion-requests-shots/run.mjs <out-dir>
