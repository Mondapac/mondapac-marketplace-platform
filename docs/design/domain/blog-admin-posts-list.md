# As built: the admin Blog posts list (list 26, 2026-11-16)

The Market's blog posts as a super list (super list plan phase 4): views with counts, search,
filters, sort, page numbers or Previous/Next, row actions and an export. Read only: every action
runs through its own use case, which checks its key, the lifecycle and the two-step rules again.
Both routes need `blog.post.read` and are admin only.

## List: `GET /blog/admin/posts`

- **Views:** `view` all (default) or one post status. `counts` gives every view for the Market,
  whatever the filter, from one grouped statement on the status. The older `status` is read as
  the view (never with `view`).
- **Filters:** `kind`, `owner` (platform or seller), `sellerId`, `featured` (true or false), `q`
  (part of the title of the open or live version, or of the slug; any case; at most 100
  characters; `%` and `_` match themselves; control characters are refused, format characters
  such as the zero-width non-joiner are kept; never echoed or logged), `from`/`to` on the last
  change (`to` excluded).
- **Sort:** created (default, newest first), updated, published, scheduled; a post never
  published or not scheduled sorts last either way; the id breaks ties.
- **Paging:** page numbers with `total` and `hasMore` (default 25, `pageSize` 1 to 100, up to row
  10,000), or Previous/Next with `cursor` and `limit`, newest created first only. A total of a
  filter that is only a view comes from the counts.
- **Rows:** as before (`items`, `page`, `pageSize`, `hasMore` stay) plus `actions`: `open`, and
  each lifecycle action (edit, submit, approve, request-changes, reviewer-edit, publish,
  schedule, unschedule, pause, resume, archive, rename-slug, feature) that the post's state
  allows (`refusalFor`) and whose key the caller holds (one probe per key: edit, review,
  publish, pause). Edit, submit and archive are offered on platform posts only (the admin use
  cases answer `blog.seller-owned` on a seller's post). Known gap: approve is offered to the
  writer or submitter of the version, which the approve use case refuses (separation of duties)
  unless the Market allows a self-approval with a two-step proof; the row has no version
  authors to hide it by.
- **Strict query:** a key outside the list above, or a repeated key, is refused.
- **No body:** the reader selects the post row and the titles of its open and live versions; no
  body, excerpt or author text.

## Export: `GET /blog/admin/posts/export`

`format` csv (default) or xlsx; `columns` adds slug, seller-id, stage, featured, scheduled,
published, created; `ids` (at most 200, no repeats; one id that is not a post of the Market
refuses the file as not found) or the list's view, filters and sort. At most 10,000 rows,
otherwise 413 `batch.too-large` with `max` and `total`. Titles are user text: the CSV writer
guards a cell that starts like a formula and XLSX cells are strings. File
`blog-posts-<day>.csv|xlsx`, the day from the injected clock. The route is declared before
`:post`.

## Changes for an older caller

The default page size is 25 (was 50); the panel's "Load more" reads `hasMore` and keeps working.

## Indexes

A status view in the default order uses (market_id, status, created_at desc, id desc); the
seller filter uses (market_id, seller_id, created_at desc, id desc). The default `all` view has
no status filter: it reads the Market's posts and keeps the newest page (a top-N sort), as do
the search over the version titles and the `updated` sort. The Market's posts are few today (a
few a week). Trigger: when a Market holds more than 20,000 posts or a list read takes more than
200 ms at p95, add (market_id, created_at desc, id desc) and a trigram index on the version
titles in a later migration (database-designer).
