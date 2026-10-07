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
| Update library | For a file that **already has the library**: adds only what this plugin release brings (new colour and Dimension variables, icons, component sets, template frames, size-table and changelog rows, version) and nothing else, apart from named fixes to items an earlier release added (exceptions, each reported by name: 1.5.0 NavDrawer item lists get gap 0 if an earlier update built them with a 2 px gap; 1.6.0 binds the drawer scrim of the three phone templates to `bg/scrim` at 100% swaps the loose `Topbar · phone` frame for a `PhoneTopbar` instance, and rewrites the scrim wording in the NavDrawer description; 1.7.0 names the existing Input variants `Type=Text, State=…` to add the `Type` axis, and replaces the Button, Input, ChecklistItem and Topbar descriptions only while they still hold the exact earlier text). That frame is the only thing it ever deletes, and only inside a plugin-made phone template; otherwise it never deletes, renames or rebuilds (only Rebuild deletes, and only what the plugin made). Running it twice changes nothing, and it refuses an empty file or a file without the library. Release 1.5.0 adds token `size/bottom-bar`, components `NavDrawer` and `BottomTabBar` and three 360 px phone templates. Release 1.6.0 adds tokens `bg/scrim` (hex8 value, alpha inside it) and `size/topbar-phone`, icon `menu` and component `PhoneTopbar`, and the two in-place fixes above. Release 1.7.0 adds the Auth tokens, 9 icons, components `BrandMark`, `Field`, `ReasonQuote`, `Menu`, `MenuItem` and `AuthShowcase`, new variants and properties on `Button`, `Input`, `ChecklistItem` and `Topbar`, the `Templates · Auth` page (a section on Starter), the three "Seller · Your seller account" templates with a phone frame, and three dark previews. Variants and properties are added only to sets the plugin made; a set or component of the same name made by someone else is skipped and reported, and so is every template that uses it. Update library does **not** rebuild the existing `Sidebar`: it keeps its drawn brand mark, while a new build places a `BrandMark` instance there. Any earlier file (1.0.0, 1.5.0, 1.6.0) goes straight to 1.7.0. Afterwards run Audit file and Export tokens. |
| Dark theme / Light theme | Switches the selected frames between themes. |
| Touch density / Desktop density | Switches the selected frames between densities. |
| Export tokens | Writes the 7 token files from the Figma variables and styles. Save them into `docs/design/tokens/`. |
| Upgrade to modes | After moving to a paid plan: merges `Color · Dark` and `Dimension · Touch` into modes and splits the Starter sections into pages. |

## Plan differences

| | Starter (free) | Professional and above |
|---|---|---|
| Pages | 3 pages, each topic is a canvas section | 27 pages with separators |
| Modes | 1 per collection: parallel `Color · Dark` and `Dimension · Touch` collections | `Color` has Light/Dark, `Dimension` has Desktop/Touch |
| Library publishing | Not available: build screens in this file | Publish this file as the team library |

## Develop

```
python3 tokens_spec.py   # only when changing the seed spec; writes spec.json, contrast-report.json, ../../tokens/*
python3 icons.py         # only when changing icons; writes icons.json
python3 build.py         # bundles src/*.js + spec.json + icons.json + contrast-report.json into code.js
node test/run.js         # strict Figma API mock: 9 scenarios (5 and 6 each update from 1.0.0, 1.5.0 and 1.6.0 files built by the 1.6.0 plugin in test/fixtures; 7-9 check the update guards), audits and token round-trip
```

- `src/42_templates_phone.js` phone templates (360 px, release 1.5.0; PhoneTopbar instance and `bg/scrim` scrim since 1.6.0) · `src/00_core.js` variables, styles, layout helpers · `10_components_core.js` icons, variant sets, instances, doc helpers
- `20_foundations.js` documentation pages · `30–32_components.js` component library · `33_components_auth.js` BrandMark, Field, ReasonQuote, Menu, MenuItem, AuthShowcase (1.7.0) · `40–41_templates*.js` screens and theme helpers · `43_templates_auth.js` Auth and "Your seller account" templates (1.7.0)
- `50_main.js` page layout, commands, export
- `icons.py` is the icon source (24 grid, drawn at 20 px, 1.75 stroke); it writes `icons.json`. Add an icon there, run `python3 icons.py && python3 build.py`, then the tests.

`tokens_spec.py` is the **seed** used to build v1.0.0. After the library exists, Figma is the source of truth:
change variables in Figma, run **Export tokens**, commit `docs/design/tokens/`. Do not run "Rebuild" on a
library that has been edited by hand — it deletes and regenerates everything the plugin made. To bring a hand-edited file to a newer plugin release use **Update library** instead.

Releases: 1.0.0 first build; **1.5.0 Mobile navigation** (D16); **1.6.0 Mobile navigation polish** (`bg/scrim`, `size/topbar-phone`, icon `menu`, `PhoneTopbar`); **1.7.0 Auth** (identity ux.md 3.1 and S1). Versions 1.1.0–1.4.0 were reserved for the Auth, Panel, Seller setup and Seller admin releases, but 1.5.0 and 1.6.0 shipped first, so that content now ships under the next free numbers, starting with 1.7.0 Auth (planned as 1.1.0 in identity ux.md 8.1); 1.1.0–1.4.0 stay unused. A release that adds library items must add an idempotent step to `updateLibrary()` in `src/50_main.js` and a case to scenarios 5–6 in `test/run.js` (one per file version it can update from). `test/fixtures/code-<version>.js` keeps the `code.js` of the last release, so the update scenarios start from files that release really built; replace it with the new `code.js` once a release is merged. Colour tokens whose value carries alpha (`bg/scrim`) are hex8 literals, not aliases: in `tokens_spec.py` write the value as `#RRGGBBAA`; the plugin stores the alpha in the variable and Export tokens writes `#RRGGBBAA` back.

`node test/run.js` must pass before a plugin change is merged. It checks, among other things, that every text
uses a text style, every paint is bound to a variable, every variable scope covers its uses, every component
property is wired, and that exporting from Figma reproduces `docs/design/tokens/` byte for byte.

### 1.7.0 Auth: frames not built yet (TODO)

- 360 px frames exist only for A1 Sign in and A7 Two-step verification (Seller and Admin). The other Auth screens are not drawn at 360 px.
- Dark preview has only Auth · Seller · A1 Sign in, Auth · Admin · A1 Sign in and Seller · Your seller account · Changes needed. The other Auth and S1 frames switch with Dark theme but have no stored dark copy.
- Customer ("Cus") variants of the Auth screens are not drawn: identity ux.md specifies them as behaviour and copy only until storefront design starts. This release covers the Seller and Admin panels.
- S1 "Seller · Your seller account" has a phone frame for Awaiting approval only.
- States drawn as behaviour and copy in identity ux.md but without their own frame yet (the frontend builds them from the drawn frame of the same screen plus the copy keys):
  - A1: the signed-out, password-changed and account-ready banners, and the `account.disabled` and `membership.none` errors.
  - A3: "sent again", throttled, and the from-sign-in body.
  - A4: wrong password, checking and "new link sent". A5: throttled. A6: "link not usable".
  - A7: "code rejected", "challenge ended", and the Staff help text.
  - A8: "code rejected", done (toast), "link not usable", and steps 2 to 4 of the admin A8 reached from the E16 link.
  - A9: the existing seller-side account ("Sign and join") state. A2 and A4: the `no-approval` copy variants.
  - A11: checking, done and "link not usable".
  - S1: the Staff variant, and the loading and error ("Try again") states.
