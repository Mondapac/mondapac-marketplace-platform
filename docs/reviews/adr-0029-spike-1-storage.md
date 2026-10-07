# ADR-0029 spike 1: object storage stand-in (evidence)

**Owner:** Hossein (backend). Kazem does the provider check and the digest pin (see "Not done").
**Measured:** 2026-10-07, SeaweedFS **built from source**, module version
`v0.0.0-20261007130238-56fbc3deb5aa` (commit `56fbc3d`, `weed version` reports 4.48), Go 1.26 toolchain,
`weed server -s3` as one process (about 194 MB RSS idle), the AWS SDK for JavaScript v3
(`@aws-sdk/client-s3`) with path-style addressing against `http://127.0.0.1:8333`, Node.js 24.20.0.
Spike code is not merged. The `ObjectStore` adapter of decision 2 is certification slice 3 and was
not written; the calls below are the calls it will make.

## Result in one paragraph
Versioning, Object Lock in COMPLIANCE mode and per-principal least privilege all work, and the
lock holds against the administrator as well. Four gaps in the stand-in for the ADR to record, none
of them in the lock path: no `PutPublicAccessBlock`, lifecycle expiry run by a separate component and
not observable in minutes, simple identities too coarse for least privilege (use policy documents),
and no bucket region. Recommendation: **accept SeaweedFS for development and CI** with those gaps
recorded as stand-in gaps (like the S5 fallback of CD 9.2), and have Kazem prove each on the
production provider; Ceph RGW and Zenko stay untried.

## Setup facts that matter
- Docker is not available here and release downloads from GitHub are blocked, so this is **not the
  digest-pinned image** of decision 1. The digest pin is Kazem's step on a machine with Docker; the
  results should be re-run on that image (the script is short: about 150 lines).
- Licence: Apache-2.0 (`LICENSE` in the source tree). The project also sells an enterprise edition;
  nothing below uses it.
- A server restart kept buckets, versions, locks and policies (data directory on disk).

## Object Lock and versioning (decisions 1 and 3)
Bucket `cert-evidence` created with `ObjectLockEnabledForBucket`: versioning is `Enabled` and the lock
configuration is read back as enabled.

| Check | Result |
|---|---|
| Put with `COMPLIANCE` and a retain-until date; `HeadObject` | Mode, date and version id come back |
| Delete the locked **version** | Refused, 403 `AccessDenied` (also for the administrator identity) |
| Delete with `BypassGovernanceRetention` | Refused |
| Shorten the retention | Refused; **extending** it is allowed |
| Change mode COMPLIANCE to GOVERNANCE | Refused |
| Plain `DeleteObject` | A delete marker; the locked version stays listed and readable by id |
| Overwrite | A new version; the old locked one stays |

## Per-principal least privilege (decision 2)
The simple identity format (`"actions": ["Read:bucket", "Write:bucket"]`) is **too coarse**: with
`Write` on the evidence bucket a runtime principal could delete objects (as a delete marker) and
**change the bucket's lifecycle** (`PutBucketLifecycleConfiguration` is checked as `Write`). Policy
documents (`"policies"` plus `"policyNames"` in the S3 config) are enforced and give the ADR's table:

| Principal and policy | Measured |
|---|---|
| `api`: `PutObject`, `GetObject`, `GetObjectVersion`, `PutObjectRetention`, multipart actions and list on `cert-evidence` and `cert-draft`; `DeleteObject` on `cert-draft` only; explicit Deny of `DeleteObject` and `DeleteObjectVersion` on `cert-evidence` | Put with lock and read back by head: ok. Delete or delete-version on evidence: 403. Put and delete in draft: ok. Multipart create and abort: ok. Lifecycle, versioning, bucket policy, lock configuration, create bucket: 403 |
| `api` on `catalog-public` and on `intake` (not granted) | 403 |
| `origin`: `GetObject` on `catalog-public` | Reads the object; put 403, list 403, read of evidence 403 |
| Anonymous | 403 on every bucket (no ACL or policy was set) |

Notes:
- Putting an object **with lock headers needs `s3:PutObjectRetention`**; without it the put fails
  with 403. So the runtime principal can lengthen a retention but never shorten it. Give it
  `PutObjectRetention` only on `cert-evidence`.
- The provisioning identity (administrator) is separate and is the only one that creates buckets and
  sets lifecycle; this matches decision 2.

## Lifecycle, multipart, public access, encryption (decisions 3, 4)
| Check | Result |
|---|---|
| Lifecycle rule `Expiration: 1 day` and `AbortIncompleteMultipartUpload: 1 day` on `intake`; non-current expiry on `cert-draft` | Accepted and read back unchanged |
| Does an object expire? | **Not observable here.** `Days` is the smallest unit, and in this version an object written after the rule has `TtlSec 0`: expiry is done by a separate lifecycle worker (admin and worker plugin, or the `s3.lifecycle.run-shard` shell command), not at write time. The stand-in is therefore not "a single container" if expiry is to run, and the intake backstop is only proven in staging, where Kazem lets a one-day rule run |
| Incomplete multipart upload | Created and listed; abort works for the principal that may; the 1-day rule is accepted but not observed |
| `PutPublicAccessBlock` | **501 NotImplemented.** The stand-in cannot hold the "blocks public access" setting of decision 3. Default is private (403 anonymous), but a bucket policy granting `*` read **did** open an object to anonymous reads (200). Controls: no runtime principal can set a bucket policy (403, measured), provisioning never sets one, a test asserts anonymous 403, and the real block is checked on the provider by Kazem |
| Default encryption (`AES256`) | Accepted and read back |
| Region | `GetBucketLocation` returns an empty constraint. The start-up region check of decision 11 needs a development value (skip when the Market configuration says "local") |

## Not done (for Kazem and later slices)
Re-run on the digest-pinned image; lifecycle expiry observed over a day; server access logging on
`cert-evidence` (decision 13); the provider check (Object Lock, lifecycle, principals, region, CDN
method and header rules, purge); the `ObjectStore` adapter and its start-up checks; Ceph RGW and
Zenko (not needed if Ali accepts the recommendation). Hassan reviews this report before ADR-0029 is
Accepted.
