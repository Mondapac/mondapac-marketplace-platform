-- Cluster bootstrap for development and CI only (docs/design/data/platform.md 10.7).
--
-- Creates the three database roles of 10.1 and hands the current database to the migration
-- role. Run it as the cluster superuser, over the Unix socket, while connected to the
-- application database:
--   docker compose: runs once on a fresh volume (/docker-entrypoint-initdb.d), and again with
--                   `pnpm db:bootstrap` when the role model changes
--   native PostgreSQL: psql -d mondapac -f scripts/db/bootstrap-dev.sql
--
-- The passwords are local-only defaults, never secrets. The file refuses to run against a
-- cluster that is not on this machine. It converges: running it again is safe.
-- Production does not use this file (10.7, Phase 7).

\set ON_ERROR_STOP on

-- Socket or loopback only, so these known passwords never land on a remote cluster.
DO $guard$
BEGIN
  IF inet_server_addr() IS NOT NULL
     AND NOT (inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() = inet '::1') THEN
    RAISE EXCEPTION 'bootstrap-dev.sql runs only over the Unix socket or loopback'
      USING HINT = 'Connect with psql inside the container or on this machine, without -h.';
  END IF;
END
$guard$;

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mondapac_app') THEN
    CREATE ROLE mondapac_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mondapac_api') THEN
    CREATE ROLE mondapac_api LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mondapac_migrator') THEN
    CREATE ROLE mondapac_migrator LOGIN;
  END IF;
END
$roles$;

-- The group every migration grants to. Member of no role, owns nothing.
ALTER ROLE mondapac_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The application's login: member of the group only.
ALTER ROLE mondapac_api LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD 'mondapac_api';
GRANT mondapac_app TO mondapac_api;

-- The migration role owns the database and everything in it. CREATEDB and pg_signal_backend
-- serve the throwaway databases of the tests and scripts (development and CI only).
ALTER ROLE mondapac_migrator LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'mondapac_migrator';
GRANT pg_signal_backend TO mondapac_migrator;

-- The database: owned by the migration role; PUBLIC loses CONNECT and TEMPORARY (10.5 gap 5).
DO $database$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO mondapac_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mondapac_app', current_database());
END
$database$;

-- Everything in the database belongs to the migration role (10.1). A volume created before
-- these roles existed holds objects of the old superuser: it is recreated, not converted.
DO $ownership$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO offending
    FROM (
      SELECT n.nspname AS name
        FROM pg_catalog.pg_namespace n
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
         AND n.nspname NOT LIKE 'pg\_%'
         AND n.nspowner <> 'mondapac_migrator'::regrole
      UNION ALL
      SELECT n.nspname || '.' || c.relname
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\_%'
         AND c.relowner <> 'mondapac_migrator'::regrole
    ) AS objects;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'objects owned by another role than mondapac_migrator: %', offending
      USING HINT = 'This database predates the role model. Recreate it: docker compose down -v, '
                   'copy .env.example to .env, docker compose up -d, pnpm db:migrate.';
  END IF;
END
$ownership$;

COMMIT;
