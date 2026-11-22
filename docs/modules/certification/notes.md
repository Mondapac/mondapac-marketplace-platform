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
  publish the save's own event (`certification-type-revised.v1`, `claim-policy-changed.v1`). Only
  `claim-policy-changed.v1` triggers a re-evaluation today (catalog re-checks the tags the policy
  touches); nothing consumes `certification-type-revised.v1` yet (see Open below). Audit: `certification.type.reverted`,
  `certification.claim-policy.reverted`, each with `requestId`.
- **Safety**: a revert is classified by the save's own rule (`classifyTypeRevision`,
  `policyRevisionDiff`). One that would relax enforcement is `not-permitted` and the request stays
  open, so a System request can never be used to loosen what `evaluateClaim` allows without the
  second admin of H1. A revert while a relaxation of the subject is pending is `not-permitted` too.
- Checks that open a unit of their own run in the reverters' pre-unit `check` (the optional
  `SystemChangeReverter.check`, called by system-requests before the decision unit): the decider
  (reviewer or withdrawing author) must hold `certification.type.edit` or
  `certification.claim-policy.edit`, and every platform category a restored policy row adds or
  changes must still be active in the Market. Any error is `not-permitted`. Inside the unit the
  revert re-runs the pure checks of the save: `validateTypeRevision` against the Market's locales
  now (claim terms, texts, `verificationMode`), and the relaxation rule.
- The type row gained `lockType` (an update under the version guard that changes nothing), the
  same lock-first pattern as the policy row.
- Open (predates this hook): catalog subscribes to `claim-policy-changed.v1` but not to
  `certification-type-revised.v1`, so a type save (or revert) that changes `defaultBasis` triggers
  no tag re-check of its own. A revert can only make `defaultBasis` stricter.

## Type reactivation: the second admin approves what they saw

Fixed before "add a new type" (FE-091; new-type design section 5):

- `type-approve-reactivation` refuses `conflict.stale` when the type's `publishedRevisionId` is no
  longer the proposal's `basedOnRevisionId`, the same check as `type-approve-relaxation`. The
  approval never makes active a revision the second admin did not see.
- `type-save-revision` refuses `review.proposal-pending` while a `type-reactivation` proposal of
  the type is pending (publish-now and relaxing saves alike). The proposer withdraws it, or a
  second admin decides it, before the type is edited.
- A System requests revert of a type is `not-permitted` while a reactivation of the type is
  pending, as it already was during a pending relaxation.

## Add a new certificate type from the admin panel (FE-091, server side)

An admin with the protected `certification.type.edit` proposes a new type; a second admin with the
same key approves it (H1). Endpoints under `certification/admin/types`:

- `GET new-options`: the Market's locales, the modes, the default bases, the badge artwork keys
  and the field limits the form needs.
- `POST` (201): code, mode, flags, default basis, badge key, texts and claim terms per locale and an
  optional reason. The type is stored `proposed` with revision 1 and a `type-creation` proposal.
  `type.code-reserved` (a code of the Market's seed) and `type.code-taken` (any status, the unique
  `(market, code)` index) answer 409.
- `POST :typeId/revisions` while proposed: the proposer only (`review.not-proposer`) saves a new
  revision; the old proposal is closed `superseded` and a new one opens (outcome
  `proposal-revised`). The reason is sealed under the new proposal.
- `POST :typeId/creations/:proposalId/approve`: a second admin, on the revision they saw (stale
  version or revision answers `conflict.stale`). The type becomes `active` in the same unit and
  `certification-type-activated.v1` is published. Reject (another admin) and withdraw (the
  proposer) close the type `rejected` or `withdrawn`; a closed type is frozen
  (`type.proposal-closed`) and never becomes live.
- `GET` lists hide rejected and withdrawn types unless `closed=true`; `GET :typeId` returns
  `pendingCreation` for a proposed type.

Rules for every type revision, new or edited (`validateTypeRevision`; the seeds of both Market
fixtures pass them): a `THIRD_PARTY_DOCUMENT` type needs a document; a `SELF_DECLARATION` type has
no issuer registry; the badge names a key of `config/certification-badge-artwork/keys.json`
(`text` shows the type's name); names and descriptions carry no forbidden word (guarantee, fatwa,
ruling, cure, allergy, health, "MondaPac certified" and similar; `domain/type-wording-data.ts`,
owned by Hassan), also split, dotted or stretched (`guaran-tee`, `g.u.a.r.a.n.t.e.e`,
`guaaaranteed`: a run of whole words is joined and its repeated letters folded); no claim term is
made only of words on the stop-list of common words (food, fresh, natural, quality, certified and
similar), so `fresh food` is refused and `certified organic` is not. The admin type list reads open
types first and closed ones only on request, so closed proposals never push an open type off its
bound. A seed code held by a type that is not live is a seed fault (`type.seed-code-not-live`).

Database (migration `20261123090000_certification_type_creation`): `status` adds `proposed`,
`rejected` and `withdrawn`; `subject_kind` adds `type-creation`. Two triggers keep the lifecycle:
a type is never inserted closed, a proposed type moves only to active, rejected or withdrawn, a
closed type is frozen and a live type stays active or inactive. Grants are unchanged.

**Exception to Hassan #142 (every type is read).** A proposed, rejected or withdrawn type is not
read by the published-types reader (claim vocabulary and type list), the seller type catalog or
the raw statements S1 to S3. Until a second admin approves it, a new type's claim terms block no
text, so one admin alone cannot block listings with a common word; a closed proposal never had an
effect. The repository's `type()` returns live types only; `typeOfAnyStatus()` serves the admin
registry's read, save and proposal paths only. Needs Hassan's review.

Deviations:

- A type-creation proposal publishes no `relaxation-proposed.v1`: its subject enum is a published
  contract, and the event has no consumer yet. The mail consumer takes a v2 that adds
  `type-creation`.
- Approval publishes only `certification-type-activated.v1`, not also a revision event: the outbox
  holds one event per aggregate version. A future re-scan consumer (FE-145) must also subscribe to
  `certification-type-activated.v1`: for a type that was never live, activation is the only signal
  that its claim terms are new.
- The audit rows (`certification.type.proposed`, `.proposal-revised`, `.created`) carry ids, the
  revision number and whether a reason was given, not the code (there is no free-text audit field
  kind).
- No route-specific rate limit; the other type writes have none either.
- The badge artwork list is configuration, not a domain constant, so artwork names are not literals
  in core code.
