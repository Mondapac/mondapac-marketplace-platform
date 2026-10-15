# Notifications: support contact (speed mode)

One setting so far: the Market's support email address.

- **Default:** `notifications.supportEmail` in `config/markets/<CODE>.json` (AU: set by the owner on
  2026-10-14). A Market without it shows no address until an admin sets one.
- **Change:** a platform admin on the admin panel's Settings page, `PUT
  notifications/admin/support-contact` with `{ email, expectedVersion }`. Needs the protected key
  `notifications.support-contact.manage` (Platform Administrator only); reading needs
  `notifications.support-contact.view` (Viewer role from seed version 9). A stale `expectedVersion`
  answers `notifications.conflict` (409), so a screen never overwrites a change it did not see.
- **Address rule:** lower-case printable ASCII (`[a-z0-9._+-]` before the "@", a dotted domain, a
  letters-only last label of two or more), at most 254 characters. No look-alike letters, and none
  of `? = & % #`, so a `mailto:` link built from it cannot carry extra parameters. An IDN domain is
  entered in punycode. The API and the database CHECK state the same rule.
- **Data:** `notifications.support_contacts`, insert-only: one row per version (address, address
  before, who, when). The current address is the highest version. It is part of the audit evidence:
  never grant UPDATE or DELETE. The audit action `notifications.support-contact.changed` records
  the version numbers only (the audit vocabulary has no text field).
- **UI:** admin Settings page, one card built from the shared `Card`, `TextField`, `Banner` and
  `Button`; screenshots at 375, 768 and 1280 px in both themes are in the project files
  (`frontend/support-email/`). Components exist already in the design system; nothing new to back-port.
- **Sign-in pages:** both panels read the address from the public route `GET /notifications/support-contact`
  (use case `notifications.view-public-support-contact`, rule `anonymous`, default rate-limit class, `no-store`,
  answer `{ email }` only, no version). If the API is unreachable or holds no address, the pages fall back to
  `PANEL_SUPPORT_EMAIL`, so that variable stays required.
- **Not yet:** a notice
  to the other Platform Administrators on each change; a recent-second-factor rule for the manage
  key (matches the other protected keys today).
