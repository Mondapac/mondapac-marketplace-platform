# boundary-fixtures

A miniature source tree full of deliberate architecture violations. `test/boundaries.spec.ts`
runs the real dependency-cruiser and ESLint configuration against it and expects every
violation to be reported, which proves the boundary rules actually fail the build. These files
are excluded from the normal lint, typecheck and build.
