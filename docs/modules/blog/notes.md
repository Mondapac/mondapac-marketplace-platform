# blog: posts, taxonomy and the seller quota, package 1 (backend core)

Speed mode (CLAUDE.md): no G1/G2 or design document. The brief and plan sections 3, 4, 5, 6, 7 and 9
of the blog package 1 hand-off are the source (outside the repo). This note records the decisions the
code takes where the brief was silent and what the code does. Frontends are out of scope.

## What it is

A Market has posts of four kinds (`product`, `brand`, `event`, `news`) written by the platform team
or, when an admin turns the switch on for a seller, by that seller. A post is versioned. A body is a
closed list of blocks validated in the domain (no HTML anywhere; text fields reject markup). Buyers
read only the live version of a published post.

## Lifecycle

- Post `status`: `draft`, `in_review`, `changes_requested`, `approved`, `scheduled` while no version
  has been live; `published`, `unpublished` or `archived` after. Version `state` is separate:
  `draft`, `in_review`, `returned`, `approved`, `live`, `retired`. A live post keeps `live_version_id`
  while `draft_version_id` is the next version being edited or reviewed.
- Write, check (pure domain), submit, review (approve or request changes), publish (now, or schedule),
  edit a live post (a new draft version from the live one), pause (at once, no review), resume,
  rename slug, archive, feature (one per Market).
- A reviewer's edit of a version in review is a new `in_review` version flagged `edited_by_reviewer`.
- Separation of duties: the approver must not be any writer of the version or its submitter. The
  writers are everyone who wrote its text in the current round: the version's writer, and back
  through reviewer edits and through drafts another writer replaced, up to the last version that
  carries a decision or was live. Only the writer of an open draft edits it in place; anyone
  else's edit retires that draft and starts a new draft version of their own, so no name is lost. Self-approval is
  allowed only where Market config `blog.selfApprovalWithStepUp` is true (AU true, ZZ false), after a
  fresh step-up (`blog.post.self-approve`, consumed inside the approve unit), and is audited
  (`selfApproved`, `stepUpVerifiedAt`).
- Approve and publish are separate keys. Publish is a protected platform key. Archive, resume, rename,
  feature and schedule use the publish key; pause uses the pause key.
- Live event status (cancel, postpone, new time) changes at once on the live version, without review,
  and is audited. It uses the edit key (a seller's own post: the seller key). The database allows only
  that column to change on a version that left draft. Because the status message goes live with no
  review, it is checked first: no outside link and no certification claim (the certification check
  must answer, else the change is refused).
- The checks read the event's venue name and address as well as the other texts readers see.
- Slugs: lower-case words, 3 to 80 characters, reserved words refused. An old slug of a renamed post is
  a redirect and is never another post's (trigger). Public by-slug answers `{kind:'post'}` or
  `{kind:'redirect', slug}` (HTTP 200), 410 `blog.gone` when the post was live and is now unpublished
  or archived, else 404 `blog.not-found`.
- Copy to Market: a package is prepared in the source Market (`GET .../copy-package`) and created in
  the target Market with `POST` and `copied: true`; the result is a new draft. Only plain writing
  travels (paragraph, heading, list, quote, tip); cards, images, links, category, tags and cover
  stay behind and the package says what was left. An event keeps its details, status back to
  scheduled.
- Scheduled publish: the job `blog.publish-due` (every minute, on the existing worker) publishes due
  posts, one unit per post, batches of 50, paging on (`scheduled_at`, `id`) so skipped posts never
  block later ones (at most 20 batches per run). A repeat or parallel run finds nothing: idempotent.
  The publisher of record is `posts.scheduled_by`, the admin who set the schedule.
- Featuring two posts at the same time leaves one featured; the other gets 409 `conflict.stale`.

## Seller posts

- `sellers.seller_admin_settings.blog_enabled` (default false, with `blog_enabled_by` and
  `blog_enabled_at`) is set by a Platform Administrator (`PUT /sellers/admin/:sellerId/blog-access`,
  key `sellers.blog-access.edit`, audited `sellers.blog-access.change`). It may ask to unpublish the
  seller's live posts; the blog handler `blog.pause-seller-posts` pauses them only when the event
  carries `unpublishLive` and the switch is still off when it runs. Whenever the switch is still off
  when the event is handled, the seller's scheduled posts lose their schedule (audited as
  `blog.post.schedule` with cause `seller-switch-off`; the version stays approved).
- `blog.seller-post.edit` is a seller-scope key that is effective only when the switch is on (checked
  in every seller use case through the sellers facade `blogAccessOf`). With the switch off all seller
  routes, reads included, answer `blog.access-off`, and admin approve, publish, schedule and resume
  of that seller's posts are refused. A seller's view of a post carries no account ids (no
  `people`, no `createdBy` in the version history).
- Quota: Market config `blog.sellerPostsPerMonth` (AU 4), counted in the Market time zone as
  "YYYY-MM", consumed once at a post's first submit by an atomic conditional update, never refunded.
  Seller posts link only product, seller and brand targets, and a product link must be one the
  seller sells.

## Tables (schema `blog`)

`posts`, `post_versions`, `post_events`, `post_links` (target types product, seller, brand, category,
page; at most 30), `categories` with `category_names` (per locale), `tags`, `post_tags` (versioned
with the version), `redirects`, `seller_quotas`, plus `outbox` and `inbox`. The CHECKs, the partial
unique indexes (one live and one open version per post, one featured post per Market), the triggers
(version lifecycle, frozen content, children only on a draft with the parent read `FOR SHARE`, event
details only for event posts, slug against redirect under a transaction lock), the partial indexes
(due queue on `scheduled_at, id`, versions by category) and the column grants are hand-written in
the migration. `posts.scheduled_by` is set exactly with `scheduled_at` (CHECK). The post pointers
to versions are deferrable composite keys.

## Permissions

`blog.post.read` (also in the Viewer seed, version 20), `blog.post.edit`, `blog.post.review`,
`blog.post.publish` (protected), `blog.post.pause`, `blog.taxonomy.edit`, `blog.seller-post.edit`
(seller scope), `sellers.blog-access.edit` (Platform Administrator).

## HTTP

Admin `blog/admin/posts` (list, create, view, draft, reviewer-edit, submit, checks, approve,
request-changes, publish, schedule put and delete, pause, resume, archive, slug, featured,
event-status, copy-package) and `blog/admin/taxonomy`; seller `blog/seller` (taxonomy, posts list,
create, view, draft, submit, archive, event-status); public `blog` (posts with market, kind,
category and paging, `posts/:slug`, `events/upcoming`, `taxonomy`).

## Known gaps

- Notifications: there is no per-account notification seam, so the submit, decision and publish
  events are emitted to the outbox with no consumer.
- Image ids and brand, category and page link targets are not verified against their modules.
- Out of scope: the new-seller-form flag, preview links, withdraw from review. A seller's "delete" is
  archive.
- The version cap is 100 per post (a CHECK); raising it needs a migration.
