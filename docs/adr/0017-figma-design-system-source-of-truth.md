# ADR-0017: Figma Design System as the Source of Truth for Panel UI

**Status:** Accepted — 2026-10-02 (owner decision: every future UI/UX change happens in Figma)
**Relates to:** ADR-0013 (module readiness gates), `docs/design/frontend-kickoff.md`,
`docs/design/figma/README.md`, `docs/design/tokens/`

## Context
The owner approved panel direction A with the components of direction C and asked for a
world-class design system in Figma. All later changes and extensions of the Admin and
Seller panel UI are to be made there. Until now the reference was a canvas preview and a
hand-written token file, so design and code could drift. The team is on Figma's Starter
plan:

- 3 pages per design file
- 1 mode per variable collection
- no team library publishing
- no Dev Mode
- the MCP write API is limited to a few calls a month

## Decision
1. **Figma is the source of truth for panel UI.** The file "MondaPac Design System" holds
   variables, text and effect styles, icons, components and screen templates. Code follows
   tokens exported from it; the canvas preview is frozen.
2. **Token architecture.**
   - Primitives (hidden, no scopes) are aliased by semantic colour tokens with Light and
     Dark values.
   - Dimension tokens have Desktop and Touch values.
   - Typography variables are bound into text styles; motion tokens are separate.
   - Every variable has a WEB code syntax `var(--mp-…)` and scopes that match its use.
3. **Generated, tested tooling.** A development plugin (`docs/design/figma/plugin`) builds
   the library, switches theme and density, audits the file and exports tokens. The export
   writes W3C DTCG JSON plus `tokens.css` and reproduces `docs/design/tokens/` byte for byte.
   A strict Figma API mock (`test/run.js`) must pass before plugin changes merge.
4. **Starter-plan layout with an upgrade path.**
   - Topics are sections on 3 pages.
   - Dark and Touch values live in parallel collections (`Color · Dark`,
     `Dimension · Touch`).
   - After a plan upgrade, the plugin command "Upgrade to modes" merges them into modes,
     rebinds every layer and splits the sections into pages.
5. **Change flow.** Changes go Sandbox → review → publish → Export tokens → PR. The review
   checklist covers tokens only, all states, both themes, touch density, contrast, and a
   clean Audit. Versions follow SemVer, with a changelog page in the file.

## Consequences
- Designers and developers share one vocabulary: Figma variable names equal CSS custom
  properties.
- Light/dark and desktop/touch exist from day one. Turning dark mode on in the product
  (D5) is now only a product decision.
- On Starter, switching a frame's theme is done with the plugin, not the Appearance panel.
  Product screens must live in the same file because the library cannot be published.
- "Rebuild" regenerates everything the plugin made. After hand edits start, the file is
  maintained by hand and the seed spec (`tokens_spec.py`) is no longer used.
- The old single `docs/design/tokens/tokens.json` is superseded by the multi-file set.
