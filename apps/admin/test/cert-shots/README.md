# Product certifications card screenshots (not part of CI)

Renders the admin product edit form (`ProductEdit`) with a mocked `/api/` and takes the
"Product certifications" card (empty, mixed list), the "Add product certificate" dialog, its
variant picker and the details drawer at 1280, 768 and 375 px in light and dark. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> node test/cert-shots/run.mjs <out-dir>
