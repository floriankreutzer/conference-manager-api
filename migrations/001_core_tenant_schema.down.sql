DROP INDEX IF EXISTS audit_events_tenant_time_idx;
DROP INDEX IF EXISTS rooms_tenant_site_idx;
DROP INDEX IF EXISTS requests_tenant_schedule_idx;

DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS requests;
DROP TABLE IF EXISTS integrations;
DROP TABLE IF EXISTS catering_items;
DROP TABLE IF EXISTS catering_packages;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
