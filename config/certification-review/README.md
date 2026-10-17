# config/certification-review

Table-shaped Market data of the `certification` module (design 5.1; Ali ruling 2026-10-17 on
ADR-0003 decision 5, see `config/markets/README.md`): one `<MARKET>.json` per Market with the
review checks, the decision reasons and the issuer request reasons, each a code with its
settings and a plain label. Scalar settings of the module (expiry warning thresholds, renewal
submit-by days) are not here: they are in the `certification` section of `config/markets/`.

- Read only by `certification`'s infrastructure (`CheckedInReviewPolicy`).
- Start-up fails if this folder is missing, a file is invalid or inconsistent (a reason naming
  an unknown check, a code twice), a file's `market` differs from its name, or a Market in
  `HOSTED_MARKETS` has no file.
- No secrets and no ADR-0026 editable setting.
- The codes are stable; the labels are working texts until the reviewer procedure and the
  ux-copy are final (Reza, Hadi). Versioned and reviewed like `config/markets/`.

The synthetic test Market's policy is the fixture `ZZ_REVIEW_POLICY` in
`apps/api/src/modules/certification/infrastructure/review-policy/zz.review.seed.ts`.
