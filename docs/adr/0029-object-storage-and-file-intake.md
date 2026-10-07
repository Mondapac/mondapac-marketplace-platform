# ADR-0029: Object Storage and File Intake

**Status:** Proposed — 2026-10-07. Drafted by Ali (cto). Spikes 1 and 2 (below) run with Hossein
(backend-developer); Kazem (devops-engineer) covers operations and the provider check; Hassan
(security-tester) reviewed it on 2026-10-07: approved with conditions, all applied (Reviews).
Accepted before `certification` slice 3 (storage decisions 1 to 5, 10, 11 and 13) and before
`catalog` slice 13 (the whole ADR); the intake decisions 6 to 8 are Accepted before
`certification` slice 4, and not before spike 2 proves H1 (decision 7). A decision a spike
disproves goes back to this ADR as a dated status line, not into code.
**Amends:** ADR-0016 decision 3 (the local stand-in is chosen here, with the Object Lock and
lifecycle criteria added to its table). ADR-0004 decision 1 (S3-compatible production storage) is
unchanged. The amended ADR is not edited; this ADR is read with it.
**Relates to:** ADR-0003 decision 1 (Region Stack, `HOSTED_MARKETS`), ADR-0008 decision 6
(boundaries), ADR-0009 decisions 5 to 7 (erasure by key destruction, abandoned drafts), ADR-0014,
ADR-0015 decision 3 (row "Redis and object-storage clients": this is that trigger), ADR-0019 R7,
R9 and decision 9 (file pipeline), ADR-0024 decision 6 (penetration-test scope), ADR-0026
decision 9; `docs/design/domain/certification.md` (CD 3.8, 9, 14.3, 15; rulings T5, T6, S5, M7,
L5), `docs/design/data/certification.md` (3.9, 10), `docs/design/domain/catalog.md` (10, 16.1;
Hassan M2, L1, L2), `docs/design/data/catalog.md` (3.19, 10.2 O7)

## Context
No code stores a file yet (ADR-0015). Phase 3 brings the first two consumers: certificate
evidence (`certification`, private, legal weight, must outlive a delete) and product photos
(`catalog`, the platform's first **public** file). Both G2 designs left the same platform
questions to this ADR: the local S3 server (MinIO's community edition is gone, ADR-0016), Object
Lock for evidence, a lifecycle backstop for raw uploads (O7), the malware scanner, the parser
sandbox and its libraries, and the cookieless origin that `catalog` needs and `certification`
deliberately does without (T5 ruling). Files are also the main way hostile input reaches the
platform: polyglots, decompression bombs, PDF scripts and EXIF location data are all in scope of
the briefs' risk tables. Every choice below must work per Market and per Region Stack.

## Decision
1. **Local stand-in: SeaweedFS (S3 gateway), pinned by digest, subject to spike 1.** It is
   Apache-2.0, maintained, a single container, and implements versioning, Object Lock (retention
   mode) and prefix lifecycle expiry. Spike 1 proves those three on our adapter; any gap fails
   the candidate. Ruled out:

   | Candidate | Why not |
   |---|---|
   | MinIO (community or free tier) | Withdrawn once already (ADR-0016); AGPL; licence and telemetry terms |
   | Garage | AGPL-3.0 (our rule: never AGPL); no Object Lock |
   | LocalStack, S3Mock, moto | Emulators: lock and lifecycle are not enforced as in S3; LocalStack's free image now needs an account token |
   | Ceph RGW, Zenko CloudServer | Full lock support, but heavy for a laptop and CI; kept as the second choice if SeaweedFS fails spike 1 |

   If no maintained candidate passes, the fallback of CD 9.2 (Ali S5) applies: the lock exists
   in production only, a staging smoke test proves it before the first production upload, this
   ADR records the gap, and the adapter **never fakes a lock**. Production is the hosting
   provider's S3 service in the Market's region (decision 11; Kazem's provider check).
2. **One port, one client, least privilege.** `ObjectStore` (CD 9.2 contract) lives in
   `platform/storage`; its adapter is the only importer of `@aws-sdk/client-s3`, enforced by
   `pnpm boundaries`. No presigned-URL package is added. Every call takes a `MarketContext`; the
   adapter refuses a Market outside `HOSTED_MARKETS`. Module code sees areas and keys, never
   buckets, regions or credentials. The API, the intake worker, the jobs and the CDN origin each
   have **their own storage principal**, limited to named areas and actions (the origin: read on
   `catalog-public` only). No runtime principal holds `DeleteObject` on `cert-evidence`, and none
   can change a bucket policy, lifecycle, versioning or lock setting; provisioning (Kazem) sets
   those. Every start-up check is read-only (Hassan M1).
3. **Buckets per area and Market; keys built only by code.**

   | Area | Holds | Versioning | Lock | Lifecycle | Public |
   |---|---|---|---|---|---|
   | `intake` | `catalog` raw photo uploads while their checks run; nothing else today | Off | No | Expire after 1 day; abort incomplete multipart after 1 day | Never |
   | `cert-draft` | Every `certification` upload, from the first byte, **encrypted** under the seller's subject key (or the platform key) before it is written; its checks run from here (CD 3.8, 9.1, M7) | Off | No | Non-current versions and incomplete multipart after 1 day | Never |
   | `cert-evidence` | Promoted certificate documents and their PNG previews | On | Object Lock enabled at creation | Incomplete multipart after 1 day | Never |
   | `catalog-private` | Photo masters, renditions not in the current published revision | Off | No | Incomplete multipart after 1 day | Never |
   | `catalog-public` | Renditions of the current published revision | Off | No | Incomplete multipart after 1 day | Only through the origin of decision 9 |

   A certificate file is never written in plaintext to `intake` or anywhere else (Hassan M3).
   A bucket name is `<stack>-<area>-<marketId lower case>`, resolved by the adapter from Region
   Stack configuration; one bucket per area per Market keeps lock, lifecycle, access policy and
   residency separate per Market, and the two-Market test fixtures get their own buckets. A key
   is a random UUID or a content address made by code (`<productId>/<sha256>-<size>` for
   catalog renditions and masters, the ciphertext SHA-256 for evidence), checked by the adapter
   against a per-area pattern. A client file name, a user string or model output is never part
   of a key. Every bucket blocks public access and has default server-side encryption; none has
   a public ACL or policy. Storage configuration is deployment configuration, never an
   admin-editable Market setting (ADR-0026).
4. **Intake lifecycle backstop (Hassan M3 of the catalog data design, O7).** The `intake` area
   expires every object after one day, the smallest S3 lifecycle unit. The primary controls stay
   those of the designs: delete when intake ends, and the 15-minute sweep that deletes raw
   objects older than one hour. S3 runs expiry asynchronously, so the backstop bounds a leaked raw
   upload at about 48 h; Hassan accepts that bound on two conditions: an **alarm fires when the
   oldest raw object in `intake` is older than about 2 h**, and no certificate file ever uses
   `intake` (decision 3). The read-only start-up check reads each area's lifecycle configuration
   and confirms that versioning is off on `intake` and `cert-draft`, and refuses to start
   otherwise; an integration test asserts the same on the local server.
5. **Evidence retention: Object Lock in compliance mode, period per object.** `cert-evidence` is
   created with Object Lock and no default retention. `promote` sets the lock mode and
   `retain-until` **in the copy request itself**, then verifies both with a head request before
   the draft is deleted; a missing or different value fails the promotion (Hassan L1).
   `retain-until` comes from the Market's retention configuration and is capped at that Market's
   configured maximum (no value before counsel answers owner question 2, so no promotion in
   production before then; T6 ruling). Compliance mode is chosen because T6 rules envelope
   encryption (erasure = key destruction, ADR-0009 decision 6), so nobody needs a privileged
   delete. A replacement is a new object; nothing is overwritten.
6. **Malware scanner: ClamAV daemon (`clamd`), out of process, fail closed (Hassan M2).** A
   self-hosted daemon per Region Stack and in compose, no external scanning service, reached only
   by the intake worker over the internal network with the `INSTREAM` command through a small
   client we write (no package). ClamAV is GPL-2.0, used as a separate program, never linked.
   `AlertExceedsMax` and `AlertEncrypted` are on and archive recursion is limited, so a file the
   scanner cannot fully read is a finding, not a pass. **Only the exact reply `stream: OK` is
   clean**; anything else, a timeout, an error, a signature set older than Kazem's threshold or a
   size above the stream limit is `refused` (`file.malware` or `file.scan-failed`). `clamd` runs
   non-root on a read-only file system with no outbound network except the `freshclam` mirror.
   Kazem owns signature updates, memory and alerts.
7. **Parsing runs in a per-file sandbox (Hassan H1).** All decoding, inspection, rasterising and
   re-encoding run in a separate intake worker process (same codebase, own entrypoint and
   container); the API process never decodes an uploaded file. Inside it, **each file is handled
   by a short-lived child in its own namespaces** (nsjail or bubblewrap): a new network namespace
   with no interface, a cleaned environment, no inherited file descriptors, no credentials or
   tokens, read-only root, small `tmpfs`, non-root, seccomp, no new privileges, and CPU, memory
   (512 MiB, CD 9.3) and wall-time limits; the parent kills it on any limit. Bytes go in and
   results come out over a pipe only. The parent checks the type and size of everything the child
   returns before it is stored. Spike 2 chooses the tool; isolating each child is not optional.
8. **Image and PDF handling.**
   - Type by content (magic bytes in our code) before any decoder sees the file. **Polyglot test
     (L5):** the format's signature must be at offset 0 and there must be no data after the
     format's end marker (JPEG EOI, PNG IEND, PDF final `%%EOF` of the last update); otherwise
     refused.
   - Images: candidate **sharp (Apache-2.0) with its bundled libvips (LGPL-3.0)**, to be confirmed
     by spike 2 and shared by both modules. Pixel cap checked from the header before decode
     (`limitInputPixels`, 40 megapixels; longest edge ≤ 12,000 px), exactly one frame or page
     (animated and multi-frame files refused), decode then **re-encode** to a fixed output format,
     all metadata stripped (EXIF, XMP, ICC beyond sRGB conversion, embedded thumbnails). Rendition
     sizes for `catalog` are `thumb`, `medium`, `large`, longest edge 2,048 px; Hossein fixes the
     two smaller sizes in spike 2 and they close the data design's list.
   - HEIC/HEIF only if spike 2 finds a decoder within the licence rule, HEVC patents included;
     sharp's prebuilt binaries are not expected to decode HEVC, so the default is "convert to JPEG".
   - PDF (`certification` only): inspection runs on the **fully parsed object graph**, object
     streams and every incremental update included, and refuses encryption, JavaScript, actions,
     embedded files, forms and XFA (Hassan L2). Each page's dimensions are capped before it is
     rasterised; pages are rasterised to PNG at ≤ 150 DPI in the sandbox; the PDF is never
     rendered by a browser (CD 9.4). Renderer candidates for spike 2: PDFium (BSD-3-Clause) or
     Poppler's command-line tools (GPL, run as a separate program); MuPDF is excluded (AGPL). No
     renderer runs with scripting enabled.
   - Limits for both: decompressed size and process memory 512 MiB, page count of CD 5.1, and
     the size limits checked while streaming.
   - After `clean`, only server-made bytes are ever shown: PNG previews, re-encoded renditions.
9. **Cookieless public origin for `catalog` renditions (Hassan L1, T5 ruling).**
   - A **separate registrable domain** (not a subdomain of the panel, storefront or API domain),
     behind a CDN that reads only `catalog-public` through its own principal (decision 2). It
     never sets or accepts cookies, accepts **only `GET` and `HEAD`**, forwards no query string,
     strips stored `x-amz-*` headers, and answers with a server-set `Content-Type`,
     `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and immutable
     caching (Hassan L5).
   - Published URLs are **immutable and unsigned**: content-addressed, built by code from the
     key (R9).
   - **Every delete from `catalog-public` purges the CDN path** in the same handler: takedown
     (catalog 10.5) and unpublish when a publish leaves a photo out (catalog 10.3). A failed purge
     is retried and alerts (Hassan M4). A copy already in a browser cache cannot be recalled; the
     takedown process accepts that.
   - Pending, draft and certificate files are never on this origin: they are streamed by the API
     with the headers of CD 9.4 and catalog 10.4. **No signed links in Phase 3**; the conditional
     signed link of catalog 10.4 is dropped (Hassan corrects that line in the same PR). Adding
     signed links later needs a new decision reviewed by Hassan.
   - Private areas are never behind the CDN. Evidence, masters and raw uploads are never public.
   - Locally, the origin is a second host name (not `localhost` with another port, which shares
     cookies); the separate-domain property is proven in staging.
10. **No file reaches a model outside the file pipeline (ADR-0019 decision 9, R9).** Only `clean`
    files enter `platform/ai`'s file pipeline, read through `ObjectStore` under the caller's
    context, and **a model receives only server-made renditions** (PNG pages, re-encoded images),
    never an original upload, a master's source or a PDF (Hassan L4). A raw upload, a refused file
    or a file refused as malware never does. A model never receives a storage URL, key or
    credential, and model output never becomes a key.
11. **Data residency is Market configuration.** Each Market's buckets and their region come from
    its configuration in the Region Stack; the read-only start-up check confirms each bucket exists
    in the Market's configured region and refuses to start otherwise. Personal data (evidence,
    drafts) stays in that region. Only published `catalog` renditions, which hold no personal data
    after metadata stripping, may be cached at CDN edges outside it; counsel confirms this before
    a Market with a stricter residency value (for example an EU Market) opens.
12. **Intake components move to `platform/storage` intake** (CD 8.2, catalog X-3): `MalwareScanner`,
    `DocumentInspector` and the image re-encoder are ports there with infrastructure adapters, used
    by both modules; each module keeps its own states, codes and limits.
13. **Logs and alerts (Hassan L3).** Storage and intake logs carry ids, codes and correlation ids
    only: never a file name, file content, a key's subject data or scanner text. Server access
    logging is on for `cert-evidence`. Alerts: signature age, scan failures, purge failures, the
    oldest-raw-object alarm of decision 4, and a failed lifecycle or versioning check.

### Spikes before Accepted
| # | Spike | Who | Proves |
|---|---|---|---|
| 1 | Storage: SeaweedFS (then Ceph RGW or Zenko if it fails) in compose, pinned by digest; versioning, Object Lock compliance mode with `retain-until` set in the copy and verified by head, a delete refused under lock, prefix expiry, abort of incomplete multipart, block of public access, per-principal policies; the adapter of decision 2 against it | Hossein; Kazem for the provider check (Object Lock, lifecycle, principals, region, CDN method and header rules, purge on the production provider) | Decisions 1 to 5; the S5 fallback if needed |
| 2 | Intake: ClamAV daemon memory, start time, throughput and the fail-closed settings; the per-file namespace sandbox of decision 7 (nsjail or bubblewrap) with its limits, proven to have no network, environment, inherited handles or credentials; sharp limits and re-encode on decompression bombs, multi-frame and polyglot samples; PDF renderer candidates on malicious samples (object streams, incremental updates, huge pages); HEIC; all on Node 24.20.0 | Hossein; Kazem for the daemon and signature updates | Decisions 6 to 8 (H1) |

Hassan reviews both spike reports before the ADR is Accepted. Spike code is not merged.

## Consequences
- New dependencies, for the owner's bundled list (certification brief s11, catalog brief s11,
  CD 15, catalog 16.1); none is installed before its slice:

  | Dependency | Kind | Licence | First slice |
  |---|---|---|---|
  | `@aws-sdk/client-s3` | npm, `platform/storage` only | Apache-2.0 | certification 3 |
  | SeaweedFS image (dev and CI) | compose service | Apache-2.0 | certification 3 |
  | ClamAV daemon | compose and production service per Region Stack | GPL-2.0 (separate program) | certification 4 |
  | nsjail or bubblewrap | binary in the intake worker image | Apache-2.0 / LGPL-2.0+ | certification 4 |
  | sharp with bundled libvips | npm, intake worker only | Apache-2.0 / LGPL-3.0 | certification 4 |
  | PDF renderer (PDFium or Poppler tools) | binary in the intake worker image | BSD-3 / GPL (separate program) | certification 4 |
  | Production object storage, CDN, a second registrable domain | hosted services | Provider terms | certification 3 (storage); catalog 13 (CDN, domain) |

- `docker compose up -d` gains two services (S3 server, ClamAV); ClamAV needs about 1 GiB of
  memory and a signature download on first start, which CI caches. Kazem updates the README and
  `.env.example` in the slice that adds them, as a shared-file PR announced on the board.
- The intake worker is a new deployable unit per Region Stack, with its own image, limits and
  storage principal; the namespace sandbox may need container settings that Kazem provides.
- Kazem provisions buckets, policies, lifecycle and lock settings outside the application;
  the application cannot repair a missing rule, it only refuses to start.
- A file slice joins the penetration-test scope (ADR-0024 decision 6; CD slice 4, catalog 13), and
  security-tester review is mandatory for every intake and serving path.
- Retention values still wait for counsel; evidence cannot be promoted in production until then.
- A leaked raw photo upload is bounded at about 48 h by lifecycle, with an alarm at about 2 h.
- `catalog` 10.4 loses its optional signed link (Hassan's line fix in the same PR).

## Alternatives considered
- **Keep scanning and decoding in the API process:** one parser bug becomes a server compromise;
  rejected (brief risk tables).
- **Container limits alone for the parsers:** a compromised parser would share the worker's
  network, environment and handles across files; rejected (Hassan H1).
- **An external scanning service:** sends seller documents (personal data) to a third party and
  across residency lines; rejected (CD 15).
- **Governance-mode lock with a privileged delete:** weaker evidence and a role to protect;
  rejected by the T6 ruling.
- **A subdomain or path on the main domain for photos:** cookies and same-site rules can reach it
  (Hassan L1); rejected.
- **Presigned S3 URLs or signed links for private files:** a link that leaks is a bearer token and
  bypasses the per-read audit; rejected for Phase 3 (T5 ruling; Hassan's answer of 2026-10-07).
- **One bucket per area shared by all Markets of a stack:** works only while every Market shares a
  region and a retention rule; per-Market buckets cost little and keep residency explicit.

## Reviews
| Reviewer | Verdict | Date |
|---|---|---|
| Hassan (security-tester) | **Approved with conditions, all applied:** H1 (decision 7), M1 (2), M2 (6), M3 (3, 4), M4 (9), L1 (5), L2 (8), L3 (13), L4 (10), L5 (9). Answers: a lifecycle bound of about 48 h is acceptable with the 2 h alarm and M3 (decision 4); no signed links in Phase 3 (decision 9). Decisions 6 to 8 are not Accepted before spike 2 proves H1 | 2026-10-07 |
