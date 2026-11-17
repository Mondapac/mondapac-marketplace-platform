# Security centre screenshots (not part of CI)

Renders the alerts list, an S1 alert, the resolve dialog and the On call tab with a mocked
`/api/`, plus the top-bar critical badge, at 1280, 768 and 375 px in light and dark. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> node test/security-shots/run.mjs <out-dir>
