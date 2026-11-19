# Seller product tags screenshots (not part of CI)

Renders the seller `EditForm` with a published product that has three tags (one archived) and a
mocked `/api/`, at 375, 768 and 1280 px in light and dark: the "Category and tags" card, the full
page, the open tag list (a bottom sheet on a phone), the list after a search, and the refused
submit. The panel shell is not drawn. Run from `apps/seller`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/product-tags-shots/run.mjs <out-dir>
