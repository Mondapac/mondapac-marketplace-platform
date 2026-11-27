# In-house rollback banner screenshots (not part of CI)

Renders the real `InHousePanel` (Mondapac Intelligence tab) with a stubbed `fetch`: a task type
rolled back and still held off (banner and the "Off, rolled back" badge), one rolled back earlier
and changed since, and no rollback, at 1280, 768 and 375 px in light and dark. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/in-house-rollback-shots/run.mjs <out-dir>
