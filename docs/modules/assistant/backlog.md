# Buyer assistant: backlog (future work)

Items the owner asked to keep for later. Nothing here is built or scheduled. When one starts, move
it into the section of `conversation.md` that describes the feature and delete it here.

## From stage 0, F2 (history and feedback in the widget; PR #1155)

Recorded on 20 Nov 2026 at the owner's request.

1. **Figma back-port of the new widget parts.** The history list ("Your conversations": header
   clock button, rows with title, date, question count and "Open now", delete confirmation, empty,
   loading and error states) and the feedback controls (thumbs, reason chips, "Thanks, noted")
   were built in code first because speed mode (2026-10-09) pauses "design system first". Add them to
   the Figma file "MondaPac Design System", export the tokens and run the plugin Audit file
   (ADR-0017). Owner of the work: Reza, with Jafar.
2. **Show the earlier rating when a conversation is reopened.** The feedback route (B3) only
   writes; the transcript read of B2 carries no rating. Needs a backend change first (add the
   buyer's own rating, and reason, to each assistant message of `GET /assistant/conversations/:id`,
   same owner checks, no new data kept), then the widget marks the thumb already given.
3. **Thumbs on older answers.** Today only the last answer can be rated. Allow rating any answer
   of the open conversation (each has its own position, so the route already supports it); depends on
   item 2 so a rated answer shows its state. Keep the rule that a chat with an unknown turn count
   records no thumbs until it is reopened.

Related: `conversation.md`, sections "Feedback and insights (B3)" and "History and feedback in the
widget".

See also the central register of deferred work (area: assistant): `docs/future-enhancements/assistant/README.md` (FE-010 to FE-013).
