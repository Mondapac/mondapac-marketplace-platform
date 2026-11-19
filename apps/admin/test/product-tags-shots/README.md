# Admin product tags screenshots (not part of CI)

Renders the admin `ProductEdit` form with three tags (one archived), the version review with a
tag change, and the products list with the optional Tags column, against a mocked `/api/`, at 375,
768 and 1280 px in light and dark: the "Category and tags" card, the full page, the open tag list
(a bottom sheet on a phone), the list after a search, a refused save, the read-only field, the review
card and the list column. The panel shell is not drawn. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/product-tags-shots/run.mjs <out-dir>
