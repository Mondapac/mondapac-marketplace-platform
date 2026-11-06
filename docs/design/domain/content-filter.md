# Content filter (platform)

Owner decision, 6 Nov 2026: free text that the public reads or hears must be clean. Alt text is read aloud by screen readers.

- **Where:** `apps/api/src/platform/content-filter/`. Pure matching (`holdsBlockedTerm`) and an injectable `ContentFilter` that reads the Market's list.
- **Config:** Market config `contentFilter.blockedTerms` (English, Persian and Arabic terms; whole words or phrases; case-insensitive; Persian/Arabic letter variants, marks and joiners are unified). No section means nothing is refused. The starter list in `config/markets/AU.json` needs a native-speaker review before fa/ar names go live.
- **Behaviour:** a field with a blocked term is refused with a validation error naming the field (code `blocked-term`; the text is never echoed or logged). Reviews keep their own check (`reviews.autoChecks`), which holds a review for a human instead.
- **Wired (package 1, catalog):** brand name, summary and logo alt text; product draft texts (a changed text keeps its last saved value and is listed in `refusedFields` as `text.blocked-term`; an import row fails with `text.blocked-term`); category names, short descriptions, keywords and search-result fields.
- **Not yet:** seller About text, business-activity description, blog text and image alt text (package 2); panel messages for the new codes.
- **Existing data:** not changed. A later edit is checked; a read-only report of old values is a follow-up.
