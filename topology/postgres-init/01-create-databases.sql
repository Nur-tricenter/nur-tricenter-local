-- =============================================================================
--  One database per microservice, named after the microservice. The
--  catalog microservice that this compose ships today is
--  "ms2-plans-and-recipes-catalog", so this script creates that
--  database. When the next microservice (e.g. inventory) comes online,
--  drop a new *.sql file in the same directory with its database name;
--  Postgres will run it on the next fresh boot of the postgres volume.
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

-- ONE database per microservice, matching the reference architecture: the catalog
-- keeps its CQRS split by SCHEMA (`write`, `read`, `outbox`) inside this single
-- database, not by a second one. Do not add a read database here.
--
-- Add a new microservice by adding another block here, e.g.:
--   SELECT 'CREATE DATABASE ms2-plans-inventory'
--   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms2-plans-inventory')\gexec

-- Identity. Named after the microservice, like every other line in this file.
--
-- The tables land in the `public` schema and the transactional outbox in `outbox`,
-- matching what IdentityDbContext maps.
SELECT 'CREATE DATABASE nur_tricenter_identity'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nur_tricenter_identity')\gexec


-- MS4 (delivery calendar). Underscored: a hyphenated name would need quoting in CREATE DATABASE.
SELECT 'CREATE DATABASE ms4_delivery_calendar'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms4_delivery_calendar')\gexec

-- MS1 (clinica nutricional). Underscored for the same reason as MS4.
SELECT 'CREATE DATABASE ms1_clinica_nutricional'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms1_clinica_nutricional')\gexec

-- MS3 (contracting and production). The API also creates it on its first migration when the
-- volume predates this line.
SELECT 'CREATE DATABASE nur_tricenter_contracting'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nur_tricenter_contracting')\gexec

-- MS5 (logistics). Optional: ms5 normally uses its own Neon database. This one lets the
-- stack run fully offline when ms5's .env points at nur-tricenter-postgres instead.
SELECT 'CREATE DATABASE ms5_logistics'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ms5_logistics')\gexec
