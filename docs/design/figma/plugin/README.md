# MondaPac Design System — Figma plugin

Development plugin that builds and maintains the MondaPac panel library (Admin + Seller) in Figma.
Process, naming and ownership rules are in [`../README.md`](../README.md) (Persian).

## Import into Figma (once per computer)

1. Figma Desktop → open any design file.
2. Menu → Plugins → Development → **Import plugin from manifest…**
3. Choose `docs/design/figma/plugin/manifest.json`.
4. Run it from Plugins → Development → **MondaPac Design System**.

## Commands (plugin panel)

| Button | What it does |
|---|---|
| Build library | Creates variables, styles, icons, components, docs and templates in an **empty** file. "Rebuild" deletes what the plugin made and builds again. |
| Update library | For a file that **already has the library**: adds only what this plugin release brings (new Dimension variables, component sets, template frames, size-table and changelog rows, version) and nothing else, apart from named fixes to items an earlier run of the same release added (1.5.0: NavDrawer item lists get gap 0 if an earlier update built them with a 2 px gap). It never deletes, renames or rebuilds (only Rebuild deletes, and only what the plugin made), running it twice changes nothing, and it refuses an empty file or a file without the library. Release 1.5.0 adds token `size/bottom-bar`, components `NavDrawer` and `BottomTabBar` and three 360 px phone templates. Afterwards run Audit file and Export tokens. |
| Dark theme / Light theme | Switches the selected frames between themes. |
| Touch density / Desktop density | Switches the selected frames between densities. |
| Export tokens | Writes the 7 token files from the Figma variables and styles. Save them into `docs/design/tokens/`. |
| Upgrade to modes | After moving to a paid plan: merges `Color · Dark` and `Dimension · Touch` into modes and splits the Starter sections into pages. |

## Plan differences

| | Starter (free) | Professional and above |
|---|---|---|
| Pages | 3 pages, each topic is a canvas section | 26 pages with separators |
| Modes | 1 per collection: parallel `Color · Dark` and `Dimension · Touch` collections | `Color` has Light/Dark, `Dimension` has Desktop/Touch |
| Library publishing | Not available: build screens in this file | Publish this file as the team library |

## Develop

```
python3 tokens_spec.py   # only when changing the seed spec; writes spec.json, contrast-report.json, ../../tokens/*
python3 icons.py         # only when changing icons; writes icons.json
python3 build.py         # bundles src/*.js + spec.json + icons.json + contrast-report.json into code.js
node test/run.js         # strict Figma API mock: 7 scenarios, audits, Update library and token round-trip
```

- `src/42_templates_phone.js` phone templates (360 px, release 1.5.0) · `src/00_core.js` variables, styles, layout helpers · `10_components_core.js` icons, variant sets, instances, doc helpers
- `20_foundations.js` documentation pages · `30–32_components.js` component library · `40–41_templates*.js` screens and theme helpers
- `50_main.js` page layout, commands, export
- `icons.py` is the icon source (24 grid, drawn at 20 px, 1.75 stroke); it writes `icons.json`. Add an icon there, run `python3 icons.py && python3 build.py`, then the tests.

`tokens_spec.py` is the **seed** used to build v1.0.0. After the library exists, Figma is the source of truth:
change variables in Figma, run **Export tokens**, commit `docs/design/tokens/`. Do not run "Rebuild" on a
library that has been edited by hand — it deletes and regenerates everything the plugin made. To bring a hand-edited file to a newer plugin release use **Update library** instead.

Releases: 1.0.0 first build; **1.5.0 Mobile navigation** (D16). 1.1.0–1.4.0 are reserved for the planned Auth, Panel, Seller setup and Seller admin releases, so versions skip. A release that adds library items must add an idempotent step to `updateLibrary()` in `src/50_main.js` and a case to scenarios 5–6 in `test/run.js`.

`node test/run.js` must pass before a plugin change is merged. It checks, among other things, that every text
uses a text style, every paint is bound to a variable, every variable scope covers its uses, every component
property is wired, and that exporting from Figma reproduces `docs/design/tokens/` byte for byte.
