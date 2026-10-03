# ADR-0021: Node.js Minimum 24.15.0, Tested in CI

**Status:** Accepted — 2026-10-03 (CTO, decided at the review of the database role and
grant note; evidence by Kazem and Hossein on 24.15.0 with `engine-strict` on). No owner
decision is changed, so none is asked; the owner is informed in the Phase 2 status summary.
**Amends:** ADR-0014 decision 1 and its first consequence
**Relates to:** ADR-0014 decisions 5 and 9, ADR-0020 decision 7, `CLAUDE.md` (Commands),
`docs/design/domain/platform-foundations.md` (sections 7 and 10),
`docs/design/domain/identity.md` (sections 6.5, 7.1, 12.3 and 14.1 item 13)

## Context
- ADR-0014 decision 1 set the minimum to Node.js 24.9, the first 24.x on which Jest can load
  NestJS 12 from CommonJS test code. The root `package.json` says `"node": ">=24.9"` and
  `.npmrc` sets `engine-strict=true`.
- The lockfile has since gained packages that refuse anything older than 24.15.0 on the 24
  line: `@angular-devkit/core`, `@angular-devkit/schematics` and
  `@angular-devkit/schematics-cli` 22.2.0 and `@nestjs/schematics` 12.0.6, pulled in by
  `@nestjs/cli` 12 (`@nestjs/schematics` is also a direct devDependency of `apps/api`),
  declare `"node": "^22.22.3 || ^24.15.0 || >=26.0.0"`. With
  `engine-strict`, `pnpm install --frozen-lockfile` fails on every 24.x below 24.15.0.
  Hossein found this in slice 0 item 1 (PR #14), whose evidence on 24.9.0 had to be produced
  with `engine-strict` off.
- So the stated minimum was a number that no environment could install and nothing tested.
  CI runs only the version in `.nvmrc` (`24`, the newest 24.x). `@types/node` is `^24.19.0`,
  so code that uses an API newer than the minimum still typechecks; only a run on the
  minimum itself catches it.

## Decision
1. **The minimum is Node.js 24.15.0**, the lowest version the lockfile installs under
   `engine-strict`. The root `package.json` declares `"node": ">=24.15.0"`. `.nvmrc` stays
   `24`.
2. **CI tests the minimum.** The verify job gets a Node axis with two values: exactly the
   minimum (24.15.0) and the `.nvmrc` version. Each runs the full job: frozen install,
   `pnpm verify`, `pnpm build` and the boot probe.
3. **The number and the axis move together.** A later raise within 24.x is one shared-file
   PR (root `package.json` `engines`, the CI axis, `README.md`, the Commands section of
   `CLAUDE.md`) approved by the CTO and noted inline in ADR-0014 decision 1 and its first
   consequence. A new major is a new ADR.

## Consequences
- Every developer machine and the CI image need Node.js 24.15.0 or later. A machine below
  that already fails `pnpm install` today, so nothing that works now stops working.
- CI runs the job twice, in parallel; wall-clock time stays about the same.
- ADR-0020 decision 7 needs no change: it says "the ADR-0014 minimum". The platform-foundations
  and identity designs already carry dated notes; what depended on 24.9.0 is re-run on
  24.15.0 (below and identity design 12.3). Javad updates risk R-9 (board request 17).
- Evidence (Kazem and Hossein, 2026-10-03, cloud workspace, Linux, `engine-strict` on):
  - Node 24.15.0: `pnpm install --frozen-lockfile` succeeds; `pnpm verify` passes (kernel
    152 tests, api 64, database tests 16, migrations reversible); `pnpm build` passes; the
    built API starts without flags and `/health/ready` answers `{"status":"ok"}`; the api
    package loads `@mondapac/shared-kernel` and its `Temporal` re-export through
    `require()`, and `globalThis.Temporal` stays undefined. This repeats slice 0 item 1's
    evidence on the new minimum.
  - Node 24.14.1: `pnpm install --frozen-lockfile` refuses ("Expected version:
    ^22.22.3 || ^24.15.0 || >=26.0.0").
  - Node 24.15.0, `node:crypto`: the RFC 9106 test vectors for argon2id, argon2i and argon2d
    match, and the RFC 6238 SHA-1 TOTP vectors match; no experimental warning is printed.
    The documented stability index of `crypto.argon2` on 24.15.0 was not checked here; it
    stays with identity spike 1.

## Alternatives considered
- **Keep 24.9 as the runtime minimum, with a newer version only for the toolchain.**
  Rejected: a minimum that nothing tests and no environment runs.
- **Downgrade `@nestjs/cli` and `@nestjs/schematics` to keep 24.9.** Rejected: it gives up the current major's
  tooling to preserve an arbitrary number.
