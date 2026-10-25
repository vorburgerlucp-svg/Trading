-- NEXUS R1 research database, step 2 (as postgres, connected to the database "nexus_research"). DRAFT: not executed yet.
-- Schema rights for the migrations (nexus_research_app) and read rights for the status role (nexus_research_readonly).
-- Safe to run again, also after the migrations.
\set ON_ERROR_STOP on

SELECT current_database() = 'nexus_research' AS on_research_database \gset
\if :on_research_database
\else
  \echo 'refused: this script must run in the database nexus_research'
  \quit
\endif

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO nexus_research_app;
GRANT USAGE ON SCHEMA public TO nexus_research_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE nexus_research_app IN SCHEMA public GRANT SELECT ON TABLES TO nexus_research_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE nexus_research_app IN SCHEMA public GRANT SELECT ON SEQUENCES TO nexus_research_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexus_research_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO nexus_research_readonly;
