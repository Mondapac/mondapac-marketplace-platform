# MondaPac design system update procedure (ADR-0017)

> Canonical procedure. The account skill `mondapac-design-system-update` loads this file; CLAUDE.md rule 12 and the slice Definition of Done point here.

The Figma file "MondaPac Design System" is the source of truth for panel UI. Code follows the
tokens exported from it. Every new page or feature therefore updates the design system
**before** the frontend builds it, and the system must never drift behind production.

## When this applies
- **G2 of a module with UI** (ADR-0013): Reza and Jafar design the module's screens.
- **A frontend slice** needs a component, variant, state, token or icon that the library does not have.
- **Production feedback** changes a token, a component or an accessibility rule.
- **After each shipped release**, as a drift check: screens in code against the Figma templates.

## 1. Prepare
- Read:
  - `docs/design/figma/README.md` (governance: structure, naming, change flow, checklist)
  - the module brief `docs/modules/<module>/brief.md` (section 12, design system impact)
  - the project doc `claude/design-status.md`
- Load skills (per `docs/process/skills-map.md`):
  - `design:design-system`: extend and document components
  - `design:ux-copy`: labels and messages
  - `design:accessibility-review`: contrast, focus, targets
  - `design:design-handoff`: the spec for Mahdi

## 2. Inventory the change (before drawing anything)
For each new screen, list every element and map it to the library. Record the result in section 12 of the module brief.

| Result | Action |
|---|---|
| Existing component fits | Use an instance. Nothing to add. |
| Existing component, new variant or state | Add the variant to the set (MINOR) |
| Existing component, new content option | Add a TEXT, BOOLEAN or INSTANCE_SWAP property (MINOR) |
| Nothing fits, and the element appears in 2 or more places or both panels | New component (MINOR) |
| Used once, module-specific | Compose from existing components inside the template. No new component. |
| New colour or size meaning | New semantic token aliasing a primitive (MINOR). Never a raw value. |
| Rename or removal | MAJOR. Use the deprecation flow in README §9. |
| New icon | Add to `docs/design/figma/plugin/icons.py`, same 24 grid and 1.75 stroke |

Prefer reuse. A new component needs a reason in the brief.

## 3. Design in Figma (Sandbox first)
1. Open Figma Desktop. On this computer, use computer-use with the Figma app.
2. Work in the **Sandbox** section, in frames named `Proposal · <component> · <ticket>`.
3. Build only with variables, text styles, effect styles and existing components. Use auto layout everywhere.
4. Draw every state: default, hover, focus, disabled, error, loading, empty. Draw touch density for seller tablet screens.
5. Check both themes with the plugin's Dark theme / Light theme buttons.
6. New screens become templates in Templates · Admin or Templates · Seller, built from instances only. Never detach the shell.

## 4. Review (README §8 checklist)
- Reza and Jafar review. Sajad checks accessibility.
- Run the plugin's **Audit file**. It must report zero warnings.
- Send the owner a short Persian summary with screenshots. Ask only the decisions that are theirs.

## 5. Publish
1. Move the component from Sandbox to its library section or page.
2. Write the Description and the usage panel: when to use, properties, accessibility, avoid.
3. Bump the version (SemVer) and add a row on the Changelog page.
4. Run **Export tokens** in the plugin with the new version. Save the 7 files into `docs/design/tokens/`.
5. Run `node docs/design/figma/plugin/test/run.js`. If tokens were not changed, Export must show no diff.

## 6. Hand over and record
- Update the handoff for the module. For a large module, add a section to `docs/design/frontend-kickoff.md` or write `docs/design/modules/<module>.md`.
- Update `docs/design/figma/README.md` when counts, structure or rules change.
- Update the project doc `claude/design-status.md`: what changed, version, and open items.
- Commit following mondapac-repo-doc-change. The owner commits; Claude does not run git commands that change the repo.

## Working notes (learned while building v1.0.0)
- Re-run the plugin with Ctrl+Alt+P. The first click inside the plugin only focuses its iframe.
- Never run **Rebuild** on the hand-edited library: it deletes and regenerates everything the plugin made. To bring it to a newer plugin release use **Update library**: it only adds what is missing and can be run again safely.
- After `device_commit_files`, compare md5 on the device. A commit made right after staging can land a stale copy.
- Figma API facts that the plugin tests enforce:
  - Nodes are not extensible.
  - Binding a colour variable resets paint opacity.
  - Changing sizing resets text truncation.
  - A TEXT property forces the same text on every variant.
- Starter plan: 3 pages, 1 mode per collection, no library publishing. After a plan upgrade, run **Upgrade to modes**.
- For a large programmatic addition, a builder can be added under `docs/design/figma/plugin/src/` using the same helpers. It must build into Sandbox and never touch existing nodes. Add it only with its tests, when the first module needs it.
