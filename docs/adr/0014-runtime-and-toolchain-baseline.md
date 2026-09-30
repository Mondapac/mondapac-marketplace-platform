# ADR-0014: Runtime and Toolchain Baseline

**Status:** Accepted — 2026-10-01 (CTO, Phase 1 review, with amendments)
**Relates to:** ADR-0008 (repository structure), CLAUDE.md (stack defaults)

## Context
The Phase 1 skeleton has to pin concrete versions. Three facts constrain the choice:
- NestJS 12 (current major) ships as ES modules. Jest can only load it from CommonJS test
  code on Node 24.9 or later, and needs `--experimental-vm-modules`; on Node 22 the test
  run fails with "Must use import to load ES Module".
- TypeScript 7 is current, but `ts-jest` and `typescript-eslint` support TypeScript below
  7 only.
- The npm `latest` tag of Prisma currently points at an 8.0 release candidate; ADR-0004
  chose Prisma v7.

## Decision
1. **Node.js 24 LTS, minimum 24.9** (`engines` in the root `package.json`, `.nvmrc`).
2. **NestJS 12**, laid out like the official NestJS 12 TypeScript template: compiled to
   CommonJS with `module: nodenext`, tested with Jest 30 + `ts-jest`, run through
   `node --experimental-vm-modules`.
3. **TypeScript 6.0.x** (pinned with `~`) until `ts-jest` and `typescript-eslint` support 7.
4. **ESLint 10 (flat config, type-aware `typescript-eslint`) + Prettier**, as the playbook
   and ADR-0008 require; not the oxlint default of the NestJS 12 template.
5. **pnpm 10** via `packageManager`. Dependency install scripts stay denied by default;
   exceptions are listed explicitly in `pnpm-workspace.yaml`.
6. **Prisma stays on major 7** (ADR-0004); it is installed with an explicit `^7` range,
   never from the `latest` tag.
7. **`pnpm verify`** is the single local gate and CI runs the same command: typecheck,
   lint, architecture boundaries, tests, database tests and the migration reversibility
   check.
8. **`--experimental-vm-modules` is test-only.** It must never appear in `start` or any
   production script.
9. **Revisit triggers.** Move to TypeScript 7 when `ts-jest` and `typescript-eslint`
   support it. Reopen the native-ESM + Vitest alternative if the VM modules flag breaks on
   a Node 24 minor release.

## Consequences
- Every developer machine and the CI image need Node 24.9+. Node 22 cannot run the tests.
- Tests print Node's "VM Modules is an experimental feature" warning. It is expected.
- Verified on Linux only so far; Windows and the GitHub Actions runner are unverified
  until their first run.
- Moving to TypeScript 7 or Prisma 8 is a deliberate upgrade with its own check, not a
  side effect of `pnpm update`.

## Alternatives considered
- NestJS 11 on Node 22: no ESM friction, but starts a new codebase one major behind.
- NestJS 12 as a native ESM project with Vitest (the template's other flavour): cleaner
  module story, but replaces Jest, which the playbook and CLAUDE.md name. Worth
  revisiting if the experimental VM modules flag becomes a problem.
