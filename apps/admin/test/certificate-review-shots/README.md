# Certificate review screenshots (not part of CI)

Renders the queue with its Review link, the review page and the Request changes dialog with fixtures at 1280, 768 and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/certificate-review-shots/run.mjs <out-dir>
