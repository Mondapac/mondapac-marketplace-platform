# catalog: implementation notes

## Review of catalogue structure edits (Admin Inbox > System requests)

Field edits of existing PLATFORM catalogue structure are reviewed in area `catalogue` (on by
default, risk medium; a Market can switch it off). The edits are category details
(`PATCH catalog/admin/categories/:id`), attribute definitions (`PUT catalog/admin/attributes/:id`)
and the attribute links of a category (`PUT catalog/admin/categories/:id/attribute-links`).

- Each takes an optional `note` (1 to 500 characters, required when the area is reviewed, so a
  save without one is a `validation.failed` on `note` and nothing is kept). Each answers
  `request: {id, number}`, or null when no request was opened (area off, or the edit changed
  nothing). The links route returns it at the top level next to `links`.
- Each admin read (category, attribute, attribute links) carries `review: {reviewed, risk}`, so the
  panel asks for a note only when it is needed.
- The request holds small plain values (see `application/catalogue-review.ts`). Category details
  are flattened per locale; an edit whose values exceed the request limits is refused with
  `too-large-for-review` where the area is reviewed.
- Reverters (`application/catalogue-reverters.ts`) are registered with system-requests and write
  through the same domain path as the edit. See `docs/modules/system-requests/notes.md` for the
  outcomes and the known limits.
- A revert runs the checks an edit has, because the rules change over time. The reverters have a
  `check` that System requests calls before the unit opens: the decider holds the edit key, the
  claim-text check passes on every text the revert would write (for an attribute that includes the
  switched-off values it keeps), the content filter and locale rules hold for a category, and the
  units and publish rules hold for an active attribute. A failure, or a check that cannot answer,
  is `not-permitted` and nothing is written. A revert that would clear `material` on a published
  attribute is refused by the domain (`changed-since`), and a revert reads at most the newest 200
  revisions of an attribute.
- Imports (the attribute file import) run through a variant of the edit use case with a recorder
  that never reviews, so a file import never needs a note.
