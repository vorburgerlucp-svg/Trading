-- NEXUS R1 research database, step 4 (after npm run research:migrate; as postgres, database nexus_research). Read only:
-- prints the checks; every row must say true.
\set ON_ERROR_STOP on
SELECT 'research roles cannot connect to nexus' AS check,
       NOT has_database_privilege('nexus_research_app', 'nexus', 'CONNECT') AND NOT has_database_privilege('nexus_research_readonly', 'nexus', 'CONNECT') AS ok
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nexus')
UNION ALL SELECT 'productive roles cannot connect to nexus_research',
       NOT has_database_privilege('nexus_app', 'nexus_research', 'CONNECT') AND NOT has_database_privilege('nexus_readonly', 'nexus_research', 'CONNECT')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app')
UNION ALL SELECT 'research roles are not superusers and cannot create roles or databases',
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'nexus_research%' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
UNION ALL SELECT 'database owner is nexus_research_app',
       (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'nexus_research') = 'nexus_research_app'
UNION ALL SELECT 'read-only role cannot write the run protocol',
       NOT has_table_privilege('nexus_research_readonly', 'append_only_records', 'INSERT')
UNION ALL SELECT 'read-only role can read the run protocol and bars',
       has_table_privilege('nexus_research_readonly', 'append_only_records', 'SELECT') AND has_table_privilege('nexus_research_readonly', 'market_bars', 'SELECT')
UNION ALL SELECT 'all 13 repository migrations applied',
       (SELECT count(*) FROM schema_migrations) = 13;
