# Seller dashboard screenshots (not part of CI)

Renders the real `SellerDashboard` with fixture data (every card, a withheld net earnings figure,
one day of data, and no sales) at 375, 768 and 1280 px in light and dark. The panel shell is not
drawn. Run from `apps/seller`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/dashboard-shots/run.mjs <out-dir>
