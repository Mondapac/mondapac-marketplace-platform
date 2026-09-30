# config/markets

Market configuration as code (ADR-0003 decision 5): one `<CODE>.json` file per Market,
validated when the API starts. A Region Stack serves only the Markets listed in its
`HOSTED_MARKETS` variable, and refuses to start if one of them has no file here.

Fields today: `code`, `status` (`planned` | `soft_launch` | `active` | `suspended`),
`defaultLocale`, `supportedLocales`, `defaultCurrency`, `settlementCurrency` and `timezone`.
`timezone` is only a fallback (ADR-0005): sellers, locations and addresses carry their own zone.
Tax, payment, carrier, certification-issuer and legal-entity settings are added by the modules
that own them, after their readiness gates (ADR-0013).
