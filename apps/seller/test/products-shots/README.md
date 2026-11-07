# Products list screenshots (not part of CI)

A throwaway page that renders the seller `ProductsList` with mocked data and a mocked `/api/`, and
takes screenshots in light at 1280 px (the table, and with filters applied) and 375 px (cards, and
the filter sheet). Run from `apps/seller`:

    VITE_PATH=<path to the vite package> PLAYWRIGHT_PATH=<path to playwright> \
      node test/products-shots/run.mjs <out-dir>

Set `CHROME_PATH` to use an installed Chrome. It builds with Vite, serves the build on a local
port and drives the browser. The page is the list alone, without the panel shell.
