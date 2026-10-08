# config/locales

Translation catalogues as configuration (INTL-11; identity design 9): text shown to people is
data keyed by locale, never a literal in core code. The API loads every catalogue when it
starts (`apps/api/src/platform/i18n/`) and refuses to start on an invalid one; `LOCALE_CONFIG_DIR`
names this directory.

Layout: `<locale>/<module>.json`. A locale directory is named by its canonical BCP 47 tag
(`en-AU`). A file is a flat JSON object of message keys to text; every key starts with the
module's name (`identity.mail.common.ignore`). Text is plain: no control or format characters,
no markup. Named placeholders such as `{url}` and `{duration}` are filled by code, never with
user text.

Which locale is used is the caller's decision. For mail it is the Market's `defaultLocale`
(`config/markets/`), and a module checks at start-up that every hosted Market's locale has every
key it needs.

- `en-AU/identity.json`: the mails of identity slice 3 (`ux.md` 5, E1 and E12).
  `identity.mail.common.footer` is marked (L) in `ux.md`: legal wording is pending and this text
  is a placeholder.

The synthetic test Market ZZ uses `ja-JP`, in `test/fixtures/locales/` (not reviewed copy; a real
ja-JP Market gets its wording from the product designer).
