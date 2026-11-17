# Admin catalogue lists, screenshots (not part of CI)

Renders one of four super lists with a mocked `/api/` (`?list=activities|tags|suggestions|proposals`)
and takes the list, a row's Actions menu, the decision dialog and, where there is one, the bulk
dialog at 1280, 768 and 375 px in light and dark. Run from `apps/admin` with Playwright and the
`vite` package folder at hand:

    VITE_PATH=<vite package folder> PW_PATH=<folder holding playwright> node test/lists-shots/run.mjs <out-dir>

`ONLY=<list>` takes one list.
