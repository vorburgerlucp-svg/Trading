-- NEXUS R1 research database, step 1 (as postgres, connected to the database "postgres"). DRAFT: not executed yet; running it is
-- a separate, explicit owner decision (docs/R1_RESEARCH_MVP.md section 6).
-- Creates two roles and the database nexus_research, only if missing. No password is set here: the roles cannot log in until
-- a password is set interactively (\password nexus_research_app), as for the productive roles. It touches no other database
-- except for removing any CONNECT right of the research roles on the productive database "nexus".
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_research_app') THEN
    CREATE ROLE nexus_research_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_research_readonly') THEN
    CREATE ROLE nexus_research_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  END IF;
END $$;

-- Every session of the read-only role is read-only by default (enforced by PostgreSQL, not by the client).
ALTER ROLE nexus_research_readonly SET default_transaction_read_only = on;
-- Bounded statements for both roles (the research instance also sets this per session).
ALTER ROLE nexus_research_app SET statement_timeout = '60s';
ALTER ROLE nexus_research_readonly SET statement_timeout = '60s';

-- The database, owned by nexus_research_app (the migrations run as that role). UTF8, from template0 (empty).
SELECT 'CREATE DATABASE nexus_research OWNER nexus_research_app ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nexus_research') \gexec

-- Nobody but the two research roles may connect to it.
REVOKE ALL ON DATABASE nexus_research FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE nexus_research TO nexus_research_app;
GRANT CONNECT ON DATABASE nexus_research TO nexus_research_readonly;

-- The research roles never connect to the productive database (PUBLIC has no CONNECT there already; this makes it explicit).
SELECT 'REVOKE ALL ON DATABASE nexus FROM nexus_research_app, nexus_research_readonly'
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nexus') \gexec
