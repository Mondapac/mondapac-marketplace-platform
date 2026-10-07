# ADR-0005: Time Zones, Local Calendars and City-by-City Rollout

**Status:** Accepted — owner requirement 2026-09-30: launch in Brisbane, then other
Australian cities; every seller and customer must behave correctly in their own time zone.
**Amends:** ADR-0002 (`Market.timezone` becomes a fallback only), ADR-0003 decision 6

## Context
MondaPac launches in Brisbane, then expands city by city across Australia before any
second country. Australia alone spans several time zones with different rules:
Queensland has no daylight saving, NSW/VIC/ACT/TAS do, SA/NT use half-hour offsets
(SA with DST), WA is two hours behind. Public holidays differ by state and even city.
A single timezone per Market (ADR-0002, INTL-01) would produce wrong cut-offs, dispatch
SLAs, certificate expiry instants, report day boundaries and notification times for
every seller or customer outside the Market's default zone.

## Decision
1. **Instants in UTC, zones as IANA IDs.** Every point in time is stored as UTC
   (`timestamptz`). A time zone is always an IANA ID (`Australia/Brisbane`) — never a
   fixed offset or an abbreviation like "AEST". Servers and databases run in UTC.
2. **Every party has its own zone.**
   - Seller: `operating_timezone`, derived from the business address at onboarding.
   - Each fulfilment/pickup location: its own timezone and business-day calendar
     (a multi-location seller can span zones).
   - Customer: a display timezone (profile, defaulted from the device); anything tied
     to delivery uses the delivery address's zone.
   - Market: `default_timezone` is only a fallback for platform-level schedules.
3. **Rules are evaluated in the owning party's zone.**

   | Rule | Zone used |
   |---|---|
   | Order cut-off, handling time, dispatch SLA, opening hours | fulfilment location |
   | Delivery windows / ETA shown to customer | delivery address |
   | Seller reports, payout schedule, tax invoice date | seller |
   | Certificate expiry (CERT-14/15) | seller; valid through the end of the expiry date, invalid from 00:00 local on the following day (owner decision) *(Amended by ADR-0028 decision 8: the zone is the seller's confirmed zone, read the same for every caller; manufacturer expiry uses the Market zone.)* |
   | Subscription expiry and reminders (SUB-06) | seller |
   | Notification quiet hours, times inside emails/SMS | recipient |
   | Promotions / campaign start and end | must declare its zone explicitly; no implicit default |

4. **Business-day calendars per location.** Public holidays come from a
   `HolidayCalendar` keyed by region (state/territory, optionally city), versioned as
   config; business-day arithmetic always goes through it.
5. **Local types in the domain.** Domain code distinguishes `Instant`, `LocalDate`,
   `LocalTime` and `ZonedDateTime` using one zone-aware library (chosen in Phase 1:
   Temporal polyfill or Luxon). Raw `Date` arithmetic and `new Date()` are forbidden in
   domain code; time comes from an injected `Clock`.
6. **Scheduled jobs are zone-aware.** "Daily" jobs (expiry, reminders, reports) run
   frequently in UTC and process each party when *its* local boundary passes, instead of
   one global midnight run.
7. **City-by-city rollout = ServiceArea configuration.** A Market contains
   `ServiceArea`s (launch: Greater Brisbane — Brisbane, Logan, Ipswich, Moreton Bay and
   Redland; exact postcode set in config), defined by postcode sets and activated by config.
   Each ServiceArea has independent flags `seller_onboarding_enabled` and
   `delivery_enabled`, so the business can decide separately where sellers may operate
   and where customers may receive orders. Adding Gold Coast, Sydney or Perth is a
   configuration change, not code. A ServiceArea does not own a timezone — zones always
   come from addresses.
8. **Proof by tests.** Fixtures include Brisbane (no DST), Sydney (DST), Adelaide
   (half-hour + DST) and Perth, plus DST-transition days, alongside the two-market
   fixtures required by ADR-0003.

## Consequences
- Seller, location and address records each carry a timezone — small, but required from
  the first migration.
- Every time shown in the UI states whose time it is, for sellers and customers alike.
- Holiday calendars and ServiceArea postcode sets need maintenance as a config task.
- NZ, MY, EU and US reuse the same model; multi-zone countries (the US) are covered.

## Alternatives considered
- One timezone per Market (previous ADR-0002 / INTL-01): rejected — wrong within Australia.
- Store local times without a zone: rejected — ambiguous around DST changes.
- One nightly job at Market midnight: rejected — fires at the wrong local time for Perth
  and Adelaide all year, and for Sydney/Melbourne half the year.
