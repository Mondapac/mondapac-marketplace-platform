# Storefront SEO settings (package S1)

The Market's SEO settings: the store, the admin API and the public read. Plan:
`seo-admin-settings.md` (sections 2 to 5). Category overrides and focus keywords are S2, the
admin UI is S3 and S4, the buyer app reads in S5, and the effective indexing rule plus the
senior-admin mail are S6.

## Store

`storefront.seo_settings`, insert-only, primary key `(market_id, version)`. The application
role has SELECT and INSERT only (no update, no delete). Version 0 is the code defaults
(`DEFAULT_SEO_SETTINGS`, indexing off) and has no row. CHECKs repeat the API bounds: the text
rule (no control or format character except U+200C, no line or paragraph separator, no `<` or
`>`, trimmed), the title template holding `{title}`, the ABN checksum, `sameAs` as at most 10
`https://` URLs, verification codes, the GA4 id and a closed `page_templates` shape. Every
row carries `market_id` and `tenant_id`; a Market never reads another Market's versions.
`storefront.outbox` is new with this package (the module had none) for the indexing event.

A save is one unit of work: stale-version check, insert, audit row and (when indexing moved)
the outbox row commit together or not at all. A version taken by a concurrent save answers
`storefront.conflict`.

**ADR-0026 deviation.** The platform market-settings store does not exist yet, so `indexing`
lives in this table (like `assistant.settings`). It moves when that store lands.

## Permissions

| Key                     | Protected                                       | Default roles                            |
| ----------------------- | ----------------------------------------------- | ---------------------------------------- |
| `storefront.seo.view`   | no                                              | platform `viewer` (seedVersion 30 to 31) |
| `storefront.seo.edit`   | no                                              | none                                     |
| `storefront.seo.manage` | yes (admin second factor; refused in acting-as) | none                                     |

## Routes (admin: `@RoutePopulation('admin')`, all answers `Cache-Control: no-store`)

| Route                                             | Needs                                                                      | Body                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /storefront/admin/seo`                       | view                                                                       | none                                                                                                                                                                           |
| `PUT /storefront/admin/seo`                       | edit                                                                       | `{ expectedVersion, settings }` with siteName, titleTemplate, defaultDescription, defaultShareImage, sellerPages, sameAs, pageTemplates                                        |
| `PUT /storefront/admin/seo/protected`             | manage + step-up `storefront.seo.change-protected`                         | `{ expectedVersion, settings }` with indexing, logo, tradingName, legalName, abn, postalAddress, contactEmail, contactPhone, googleVerification, bingVerification, analyticsId |
| `GET /storefront/admin/seo/history?after=&limit=` | view                                                                       | none (limit 1 to 50, default 20)                                                                                                                                               |
| `POST /storefront/admin/seo/restore`              | edit; also manage + step-up when the old version changes a protected field | `{ expectedVersion, version }` (version 0 = defaults)                                                                                                                          |

Answers of GET, PUT, PUT protected and restore:
`{ version, settings, sampleDataLock, envCeiling, lastChanged }`. `lastChanged` is
`{ version, at, by }` or null at version 0. History items: version, when, who (display name,
never an email) and the names of the changed fields, never their values.

Refusals: `validation.failed` 400 with `details.fields[{path, code}]`; `access.denied` 403;
`second-factor.required` or `second-factor.enrolment-required` 403 with `details.actionKey`;
`storefront.conflict` 409 with `details.lastChanged`; `storefront.seo-version-not-found` 404.
The same settings again change nothing (no version, no audit row, no event). A stale version or
a no-op keeps the second-factor proof unspent. Turning indexing on while `sampleDataLock` is
true is `validation.failed` (code `locked`).

## Public read

`GET /storefront/seo` (`@RoutePopulation('customer')`, no session, Market from the host):
`{ seo: { indexing, siteName, titleTemplate, defaultDescription, shareImage, logo, sellerPages,
organization, verification, analyticsId, templates } }`. Never the version, the editor or a
focus keyword. Defaults while nothing is saved. `no-store`; the buyer app caches.

## Audit and events

- Audit `storefront.seo-settings.changed`: before `{version, indexing}`, after `{version,
indexing, changed[], restoredFrom?, stepUpSessionId?, stepUpVerifiedAt?}`. Changed fields are
  names only.
- Event `storefront.seo-indexing-changed.v1` (aggregate `seo-settings`, payload `{version}`),
  written only when the indexing value moved (including by a restore). The name differs from the
  brief (`storefront.seo-indexing.changed.v1`) because the event-name rule allows one verb
  segment.

## Environment

- `STOREFRONT_INDEXING` is an off-only ceiling: unset or `off` keeps pages out of the index
  whatever the setting says. It is reported as `envCeiling`; applying the rule is S6.
- `STOREFRONT_SAMPLE_DATA` locks turning indexing on (`sampleDataLock`).
