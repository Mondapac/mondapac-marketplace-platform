-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261019211148_platform_rate_limit_counters: the grant, then the table. Only
-- transient counters are lost; every origin starts a fresh window.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."rate_limit_counters" FROM "mondapac_app";

DROP TABLE "platform"."rate_limit_counters";
