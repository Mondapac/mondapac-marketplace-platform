# Future-enhancements register

Every feature or upgrade that is deferred to the future is recorded here AND in the owning
area's own docs (owner rule, 21 Nov 2026).

## How it works (merge-conflict free)

- **One small JSON file per item** in `items/`. Two pull requests never edit the same file,
  so adding an item never conflicts with another open PR and never changes a PR head because
  of a rebase.
- **IDs do not collide.** Existing items keep their `FE-NNN` ids. New items use
  `FE-YYYYMMDD-<slug>` (the slug is lowercase kebab-case ASCII, for example
  `FE-20261124-orders-export-chunking`). The file name is `<id>.json`.
- **Aggregated views are generated, not committed.** `README.md` of each area folder is a
  fixed stub. Never edit or commit anything under `_generated/` (git ignores it).
- To change the status of an item (done, obsolete), edit only that item's file.

## Add an item

```
python3 docs/future-enhancements/generate.py new \
  --slug orders-export-chunking --area orders \
  --title "..." --desc "..." --src "PR 1234 (reviewer)" --trig "when ..." \
  [--prio بالا|متوسط|پایین] [--status موکول]
```

Fields: `area` (see `areas.json`), `title`, `desc`, `src`, `date` (YYYY-MM-DD, filled in by
the command), `trig` (the condition or time to do it), `prio`, `status`
(`موکول`, `انجام‌شد`, `منسوخ`, `نیاز به بررسی`). Do not edit `areas.json` or
`generate.py` in a feature PR.

## Read the register

`python3 docs/future-enhancements/generate.py` builds `_generated/README.md` (all items by
area), one `<area>.md` per area and `report-fa.html`. `--out DIR` writes them elsewhere
(the project's central register uses this). `--check` validates every item file; it runs in
`pnpm verify:static`.
