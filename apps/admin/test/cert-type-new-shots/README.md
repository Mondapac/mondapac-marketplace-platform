# Certificate type creation screenshots (not part of CI)

Renders the types list (N1), the New type form (N2), its review dialog (N3) and a proposed type
(N4) with fixtures and a mocked count, at 1280, 768 and 375 px in light and dark. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> NODE_PATH=<folder with playwright> CHROME_PATH=<chrome, optional> \
      node test/cert-type-new-shots/run.mjs <out-dir>
