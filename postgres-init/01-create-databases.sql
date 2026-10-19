-- =============================================================================
--  One database per microservice, named after the microservice.
--
--  The guide this orchestrator mirrors (ms2026-store) does this for every
--  one of its 5 services: StoreIdentity, StoreCatalog, StoreInventory,
--  StoreOrders, StorePayments. The catalog microservice that this
--  compose ships today is "ms2-plans-and-recipes-catalog", so this script
--  creates that database. When the next microservice (e.g. inventory)
--  comes online, drop a new *.sql file in the same directory with its
--  database name; Postgres will run it on the next fresh boot of the
--  postgres volume.
--
--  Why this lives here and not in the catalog's --migrate step: the
--  microservice's startup migration runs AFTER the container is up, and
--  it targets one specific database. If that database does not exist,
--  the migration cannot connect. The init script ensures the database
--  exists before the container starts accepting connections.
--
--  The catalog's database is already created by POSTGRES_DB in
--  docker-compose.infra.yml; the CREATE DATABASE here is therefore a
--  no-op on a fresh volume (the database already exists) and idempotent
--  on a later boot (the SELECT returns 0 rows). Both branches end with
--  a populated database.
-- =============================================================================

-- Idempotent CREATE DATABASE. psql does not parameterize identifiers,
-- so we use \gexec to feed the SELECT result into a CREATE DATABASE
-- statement only when the row count is non-zero.
SELECT 'CREATE DATABASE ms2-plans-and-recipes-catalog'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms2-plans-and-recipes-catalog')\gexec

-- Add a new microservice by adding another block here, e.g.:
--   SELECT 'CREATE DATABASE ms2-plans-inventory'
--   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms2-plans-inventory')\gexec
