# ADR-0016: Local Object Storage After the Removal of MinIO Images

**Status:** Proposed — 2026-10-01. Decision 1 is applied because the old setup cannot
start; decisions 2 and 3 need the owner's confirmation (they change a stack default).
**Amends:** ADR-0004 decision 1 ("MinIO locally"), ADR-0006 consequences (the list of
Docker Compose services), CLAUDE.md stack line
**Relates to:** ADR-0015 (object-storage client deferred until first use), CERT-10

## Context
ADR-0004 chose S3-compatible object storage with MinIO as the local server, and the
Phase 1 `docker-compose.yml` included a `minio/minio` service. MinIO has stopped
publishing its community edition: the `minio/minio` repository no longer exists on Docker
Hub (checked 2026-10-01: the registry API returns "not found" for the repository and for
the pinned tag), and public reports say the Quay mirror now refuses anonymous pulls. With
that service in the file, `docker compose up -d` fails for everyone, although no code uses
object storage yet (ADR-0015).

## Decision
1. **Remove the object-storage service from `docker-compose.yml` now.** Local development
   needs PostgreSQL, Redis and the mail catcher today; those three stay.
2. **Production stays S3-compatible object storage** (ADR-0004 is unchanged on this
   point). Only the local stand-in changes.
3. **Choose the local stand-in with the first consumer.** Before the first slice that
   stores a file (certificate documents, CERT-10, Phase 3), the CTO runs a short vendor
   review of maintained S3-compatible servers and adds the chosen one to
   `docker-compose.yml` together with the storage adapter and its integration test.
   Candidates to compare:

   | Candidate | For | Against |
   |---|---|---|
   | SeaweedFS (`-s3` mode) | Apache-2.0, long-lived project, single container | Larger feature surface than needed; S3 edge cases to verify |
   | Garage | Small footprint, simple | Limited lifecycle-policy support; needs a bootstrap step |
   | Emulator aimed at tests (for example LocalStack S3 or S3Mock) | Fast, made for development | Not a real server; behaviour can differ from production S3 |
   | MinIO commercial free tier | Closest to the earlier plan | Licence terms and telemetry; vendor already withdrew the community edition once |

   None of these has been run for this project; the table lists what the review must check.

## Consequences
- `docker compose up -d` works again. Nothing else changes for Phase 2, which stores no
  files.
- The choice is made when there is code to test it against, not on reputation alone.
- Phase 3 gets one more prerequisite: this review, before the certificate upload slice.

## Alternatives considered
- Point the service at another registry or an old mirrored tag: depends on images the
  vendor has withdrawn and no longer patches.
- Pick a replacement now: it could not be verified (no consumer, and it would be the
  second unverified image in this file).
