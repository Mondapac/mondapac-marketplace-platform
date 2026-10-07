# Use-case discovery fixtures

Source trees for `test/authz/use-cases.spec.ts`, the discovery and CI check of identity
design 5.2 (slice 1c). Each tree stands in for `apps/api/src/` and holds a `modules/` folder.

- `valid/` passes every check: one use case of each rule kind, keys declared in
  `contracts/`, and its own checked-in list (`access-declarations.json`).
- `broken/` holds one file per refused case; the spec asserts the exact list of problems.

The fixtures are type-checked with the API (no `@ts-expect-error`); a declaration that the
types would refuse is cast, because the check must refuse it at run time too. Nothing here is
loaded by the application.
