# ADR-0029 spike 2: file intake (evidence)

**Owner:** Hossein (backend). Kazem is asked for the items under "Not measured".
**Measured:** 2026-10-07 in a cloud container (Linux 6.18, root, no cgroup v2, no Docker), Node.js
24.20.0, sharp 0.35.5 with libvips 8.18.7, bubblewrap 0.9.0, ClamAV 1.5.4, qpdf 11.9, Poppler
(pdfinfo, pdftoppm) 24.02, all from the Ubuntu 24.04 archive or npm. Spike code is not merged
(ADR-0029, Spikes). Samples were generated for the test and are not committed.

## Result in one paragraph
Decisions 7 and 8 are **partly proven**. Proven here: the sandbox properties of bubblewrap (no
network, clean environment, no inherited descriptors, no credentials, read-only root, caps
dropped, wall-time kill), the sharp re-encode and the main PDF checks. **Not proven:** seccomp,
the memory limit, ClamAV with a real signature set, and bubblewrap inside the production worker
container run as a non-root user (this spike ran as root outside Docker). Four corrections for
the ADR text: (1) the 512 MiB memory limit of the child cannot be a process rlimit for Node with
sharp, so it comes from a cgroup limit on the intake worker container (Kazem), not per file; (2)
ClamAV does not alert on an archive **member** above `MaxFileSize` (measured for a zip only), so
bomb protection is our type allow-list and size caps, never the scanner, and ClamAV is
signature-based defence in depth; (3) sharp reads only the first frame of an APNG, so APNG must
be refused by an `acTL` chunk check of our own; (4) qpdf does not see bytes after the final
`%%EOF`, so the polyglot rule of decision 8 stays our own check.

## 1. ClamAV (decision 6)
The signature mirror `database.clamav.net` is blocked from this container, so `freshclam` failed
and **no real signature set was loaded**. The daemon was run with one local signature (the EICAR
file), which proves configuration and reply handling, not memory or start time with a real set.

Settings used: `StreamMaxLength 10M` (1M for the first case), `MaxFileSize 1M`, `MaxScanSize 2M`,
`MaxRecursion 8`, `MaxFiles 50`, `AlertExceedsMax yes`, `AlertEncrypted yes`,
`AlertEncryptedArchive yes`, `AlertEncryptedDoc yes`, `ScanPDF yes`, `ScanArchive yes`. Replies
over `INSTREAM` on a Unix socket:

| Input | Reply | Our result |
|---|---|---|
| `hello world` | `stream: OK` | clean |
| EICAR, plain and inside a zip | `… FOUND` | `file.malware` |
| Stream above `StreamMaxLength` | `INSTREAM size limit exceeded. ERROR` | `file.scan-failed` (not the exact `stream: OK`) |
| Plain file above `MaxFileSize` or `MaxScanSize` | `Heuristics.Limits.Exceeded.MaxFileSize FOUND` | `file.scan-failed` |
| Encrypted zip | `Heuristics.Encrypted.Zip FOUND` | refused |
| Zip nested 10 deep (`MaxRecursion 8`) | `Heuristics.Limits.Exceeded.MaxRecursion FOUND` | refused |
| Zip whose member is 3 MB of zeros (`MaxFileSize 1M`) | **`stream: OK`** | **clean: a gap** |
| Empty stream | `stream: OK` | our minimum-size check must catch it |

Corrections and notes:
- The gap in the zip row: the scanner skips an oversize archive member without an alert although
  `AlertExceedsMax` is on. Decision 8 accepts only JPEG, PNG and PDF, so archives are refused by
  type; a PDF's decompressed streams are bounded by our parser limits and the sandbox. The ADR
  should say the scanner is **not** a decompression-bomb control.
- Only the exact reply `stream: OK` was treated as clean in this spike, as decision 6 says.

## 2. Per-file sandbox (decision 7), bubblewrap
`bwrap --unshare-all --die-with-parent --new-session --clearenv --uid 65534 --gid 65534
--cap-drop ALL`, read-only `/usr`, `tmpfs` `/tmp`, `/proc` and `/dev`, the input bound read-only at
`/in`, then `prlimit --cpu`.

| Property (ADR) | Measured |
|---|---|
| New network namespace, no interface | Only `lo`; `connect` to 1.1.1.1 fails with "Network is unreachable" |
| Cleaned environment, no credentials | `PATH` only; parent's `SECRET_TOKEN` and `AWS_SECRET_ACCESS_KEY` absent; `/root` and `/home` do not exist |
| No inherited file descriptors | With a leaked descriptor 7 in the parent, **bubblewrap passed it into the child**. Spawned from Node (`child_process`, default stdio), only 0, 1, 2 reached the child. So the parent must be Node's `spawn` with explicit `stdio`, and the intake worker must never hold other descriptors open without `CLOEXEC` |
| Read-only root, small `tmpfs` | Write to `/usr` fails (read-only file system); `/tmp` writable and discarded |
| Non-root, caps, no new privileges | uid 65534; `CapEff` 0; `NoNewPrivs` 1 |
| Wall-time limit | `timeout -s KILL 2` ended a busy-loop child at 2.0 s; no process left behind |
| Parent dies | `kill -9` of the bubblewrap process left no child |
| Seccomp | **Not applied here.** `bwrap --seccomp` needs a compiled BPF program; writing it is part of the implementation (certification slice 4) and Kazem reviews it |
| Memory limit | See 3: a process rlimit does not work for Node with sharp |

## 3. Images with sharp (decision 8)
A child script did: type by magic bytes (JPEG, PNG, and GIF/WebP only to test the frame check),
signature at offset 0 and end marker at the end, `limitInputPixels` 40,000,000, one page, longest
edge ≤ 12,000, decode, `rotate()`, resize to fit 2,048, convert to sRGB, **re-encode to JPEG**.
All of it ran inside the sandbox of section 2.

| Sample | Result |
|---|---|
| 1200×800 JPEG and PNG with EXIF (GPS, make, copyright) | clean; output has **no EXIF, ICC or XMP**; 20 to 25 ms, peak RSS 74 MB |
| JPEG with a zip appended; PNG with HTML appended | `file.polyglot` (end marker check) |
| GIF header before a JPEG; HTML named `.jpg` | `file.type` |
| Truncated JPEG | `file.polyglot` (no end marker) |
| 49 MP JPEG (7,000×7,000); 20,000×20,000 and 8,000×8,000 1-bit PNG bombs (48 KB and 8 KB files) | refused by the pixel cap in 2 to 3 ms, before any decode |
| 13,000×100 JPEG | `file.dimensions` |
| Animated GIF; animated WebP (3 frames) | `file.frames` from `pages` |
| **APNG** (a PNG with an `acTL` chunk) | libvips reports one page, so only our `acTL` check refuses it |
| 36 MP noisy JPEG (16.6 MB), a legal worst case | clean in 0.6 s, **peak RSS 132 MB**, output 2,048 px |

Corrections and notes:
- **Memory limit.** Under `RLIMIT_AS`: 2 GiB works; 1.5 GiB fails the 36 MP decode in libvips
  ("Insufficient memory"); 1.25 GiB and below crash Node at start. `RLIMIT_DATA` of 512 MiB or less
  also crashes Node. So the 512 MiB of CD 9.3 is enforced as a **cgroup `memory.max` on the intake
  worker's container** (Kazem), with `RLIMIT_AS` at 2 GiB as a second line. The measured peak RSS
  for the largest legal image is 132 MB, so 512 MiB has margin. cgroup v2 is not available in this
  container, so the cgroup limit itself was not measured.
- **Type allow-list is ours.** The prebuilt libvips also reads SVG, TIFF, GIF, WebP and AVIF; only
  files that pass our magic-byte check for the module's allowed types ever reach `sharp`.
- **Licences.** `sharp` is Apache-2.0; `@img/sharp-libvips-*` is LGPL-3.0-or-later (it bundles
  libimagequant 2.4.1 and cgif among others, listed in its `versions.json`); to be confirmed against
  the notices file when the dependency is added (certification slice 4).
- **HEIC.** `sharp.format.heif` lists only `.avif` as an input suffix, so the prebuilt cannot
  decode HEVC; the default of decision 8 ("convert to JPEG" on the client or refuse) stands. No
  HEIC sample could be made (no HEVC encoder in the archive), so this rests on the format listing.
- **Rendition sizes (open in the ADR).** Proposal for `catalog`: `thumb` 320, `medium` 960, `large`
  2,048 px longest edge (a grid card is about 160 CSS px, a product page about 480; both at 2×).
  Hassan and Reza confirm.

## 4. PDF (decision 8)
Pipeline tried: `qpdf --is-encrypted`; `qpdf --qdf --object-streams=disable` (it parses object
streams and every incremental update) then a search of the result for `/JS /JavaScript /AA
/OpenAction /Launch /EmbeddedFile /EmbeddedFiles /XFA /AcroForm /RichMedia /URI /SubmitForm /GoToR
/ImportData`; `pdfinfo` for the page size; `pdftoppm -r 150` in the sandbox.

| Sample | Result |
|---|---|
| Plain one-page PDF | passes; `pdftoppm` writes a PNG (0.05 s) |
| JavaScript in the catalog; the same inside an object stream; JavaScript added only by an **incremental update** | all refused (`/JS /JavaScript /OpenAction`) |
| AES-256 encrypted PDF | refused (`--is-encrypted`) |
| Not a PDF | refused (qpdf cannot parse) |
| Page of 200,000×200,000 pt | `pdfinfo` reports the size, so the page cap runs before rasterising; without the cap `pdftoppm` under a 1 GiB address-space limit fails with "Bogus memory allocation size" and is contained |
| Valid PDF with HTML bytes after the final `%%EOF` | **passes qpdf**; the polyglot rule (nothing after the last `%%EOF`) must be our own check |

PDFium was not tried (no packaged build in the archive). qpdf is Apache-2.0 and Poppler's tools
are GPL, run as separate programs; to be confirmed in the worker image.

## Not measured (for Kazem and the slice)
ClamAV memory and start time with the real signature set, and `freshclam` from the production
network; the cgroup memory limit; the seccomp filter; nsjail (bubblewrap met the ADR's list, so it
is the proposal); PDFium; a real HEIC sample; throughput under load. Hassan reviews this report
before ADR-0029 is Accepted.

Also not measured: an oversize stream inside a PDF under ClamAV, ClamAV over the internal network
instead of a Unix socket (clamd has no authentication; `SHUTDOWN` and `RELOAD` must be
unreachable from other hosts), a multi-page PDF and `/UserUnit`, hex-escaped PDF names,
JBIG2Decode and JPXDecode, a 40 MP interlaced 16-bit PNG, a pids limit, a size-limited tmpfs,
`RLIMIT_FSIZE` and `RLIMIT_NOFILE`, and the descriptors of a real worker with database, S3 and
clamd connections open.

## Conditions before ADR-0029 is Accepted (Hassan and Bagher, 2026-10-07)

1. **Sandbox (decision 7).** A probe suite passes in CI on the real worker image, run as its
   non-root user with Kazem's production container settings (not `privileged`, not
   `seccomp=unconfined`): a seccomp allow-list, `--disable-userns` or equivalent, and a probe
   inside the child that asserts `ptrace`, `mount`, `unshare`, `setns`, `keyctl`, `bpf`,
   `perf_event_open`, `userfaultfd`, `io_uring_*`, `process_vm_*` and `open_by_handle_at` fail. If
   bubblewrap cannot run that way, nsjail or another mechanism is chosen and the suite re-run.
   Kazem's list gains "bubblewrap inside the production container".
2. **Descriptors.** The launcher closes every descriptor above 2; a test on the real worker lists
   `/proc/self/fd` in the child and expects 0, 1 and 2 only.
3. **Limits.** Each child has its own limits (address space, file size, open files, pids, a
   size-limited tmpfs, wall and CPU time, an output cap); the cgroup figure is measured with the
   worst legal image and PDF, and every parser (`qpdf`, `pdfinfo`, `pdftoppm`, sharp) runs inside
   the sandbox.
4. **Scanner (decision 6).** ADR wording becomes: ClamAV is a signature check, not a
   decompression-bomb or completeness control; scan and parse use the same bytes (SHA-256). A
   run with the real signature set, production size limits and an oversize PDF stream is
   recorded first.
5. **Polyglot (decision 8).** The end rule is a structural parse (JPEG segments to the real EOI,
   PNG chunks with CRC to IEND, PDF last `startxref` and `%%EOF`), tested with appended payloads
   that themselves end in `FFD9`, `IEND` and `%%EOF`.
6. **PDF (decision 8).** An allow-list of objects and actions, not only a search for names;
   JBIG2Decode, JPXDecode and Crypt refused unless condition 1 holds; the page, size and DPI caps
   are numbers in the ADR. The `/URI` refusal is a product decision for the owner.
7. **HEIC and HEIF** are refused at intake.
8. **ADR amendment.** Ali amends ADR-0029 with the four corrections and these conditions; merging
   this report does not do it. Spike code and sample generators are kept under
   `docs/reviews/spikes/` or attached for re-runs; slices 3 and 4 turn each property into a CI
   test.
