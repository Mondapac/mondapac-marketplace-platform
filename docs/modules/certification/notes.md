# certification: implementation notes

## Admin Inbox › System requests (area certification)

Built under speed mode from the System requests design (owner decisions of 15 Nov 2026); the
contract is in `docs/modules/system-requests/notes.md` ("Hooked areas").

- Reviewed edits: a **type revision** (`POST certification/admin/types/:typeId/revisions`) and a
  **claim-policy revision** (`POST certification/admin/claim-policies/:typeId/revisions`) that are
  published at their save. The save takes an optional `note` (required while the Market reviews
  area certification; 400 on `note` without it, and nothing is saved) and answers `request`
  (`{id, number}` or null). `GET` of a type and of a claim policy carry `review: {reviewed, risk}`.
- Not reviewed: a relaxing save (it already waits for a second admin, H1) and its approval;
  creating, deactivating and reactivating a type; every issuer change; every decision on a seller's
  certificate or a product certification (approve, reject, revoke, suspend, reinstate).
- The reverters (`application/registry/registry-reverters.ts`) restore the revision before as a
  **new** published revision (a save is never an edit), lock the type or policy row first, and
  publish the save's own event (`certification-type-revised.v1`, `claim-policy-changed.v1`), so
  the downstream re-evaluation is the one a save triggers. Audit: `certification.type.reverted`,
  `certification.claim-policy.reverted`, each with `requestId`.
- **Safety**: a revert is classified by the save's own rule (`classifyTypeRevision`,
  `policyRevisionDiff`). One that would relax enforcement is `not-permitted` and the request stays
  open, so a System request can never be used to loosen what `evaluateClaim` allows without the
  second admin of H1. A revert while a relaxation of the subject is pending is `not-permitted` too.
- The type row gained `lockType` (an update under the version guard that changes nothing), the
  same lock-first pattern as the policy row.
- Open (predates this hook): catalog subscribes to `claim-policy-changed.v1` but not to
  `certification-type-revised.v1`, so a type save (or revert) that changes `defaultBasis` triggers
  no tag re-check of its own. A revert can only make `defaultBasis` stricter.
