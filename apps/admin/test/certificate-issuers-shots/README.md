# Certificate issuers screenshots (not part of CI)

Renders the issuers list, an issuer page, and the New issuer and Activate dialogs with fixtures at
1280, 768 and 375 px in light and dark. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/certificate-issuers-shots/run.mjs <out-dir>
