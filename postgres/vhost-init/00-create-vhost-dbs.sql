\set ON_ERROR_STOP on

SELECT format('CREATE DATABASE %I', dbname)
FROM (VALUES
    ('rediff_v1_db'),
    ('rediff_v2_db'),
    ('rediff_v3_db'),
    ('rediff_v4_db')
) AS v(dbname)
WHERE NOT EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = v.dbname
)
\gexec

\connect rediff_v1_db
\i /pg-schema.sql

\connect rediff_v2_db
\i /pg-schema.sql

\connect rediff_v3_db
\i /pg-schema.sql

\connect rediff_v4_db
\i /pg-schema.sql
