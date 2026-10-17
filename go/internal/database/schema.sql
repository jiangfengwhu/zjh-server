CREATE TABLE IF NOT EXISTS catalog (
 key text COLLATE "C" PRIMARY KEY,
 value jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Durable Object KV source records retain their namespace and identity during
-- import. Services can add relational read models without losing source data.
CREATE TABLE IF NOT EXISTS object_records (
 namespace text NOT NULL,
 object_id text NOT NULL,
 key text COLLATE "C" NOT NULL,
 value jsonb NOT NULL,
 PRIMARY KEY(namespace,object_id,key)
);
CREATE TABLE IF NOT EXISTS application_collections (
 tenant text NOT NULL, app_id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(tenant,app_id,name)
);
CREATE TABLE IF NOT EXISTS application_records (
 tenant text NOT NULL, app_id text NOT NULL, collection text NOT NULL,
 id text NOT NULL, data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
 created_by text NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL,
 version bigint NOT NULL CHECK (version > 0), bytes bigint NOT NULL CHECK (bytes >= 0),
 PRIMARY KEY(tenant,app_id,collection,id),
 FOREIGN KEY(tenant,app_id,collection) REFERENCES application_collections(tenant,app_id,name)
);
CREATE INDEX IF NOT EXISTS application_records_created ON application_records(tenant,app_id,collection,created_at,id);
CREATE INDEX IF NOT EXISTS application_records_updated ON application_records(tenant,app_id,collection,updated_at,id);
CREATE TABLE IF NOT EXISTS idempotency_requests (
 tenant text NOT NULL, user_id text NOT NULL, request_id text NOT NULL,
 signature text NOT NULL, result jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant,user_id,request_id)
);
CREATE INDEX IF NOT EXISTS idempotency_requests_expiry ON idempotency_requests(expires_at);
CREATE TABLE IF NOT EXISTS scheduled_jobs (
 namespace text NOT NULL, object_id text NOT NULL, due_at timestamptz NOT NULL,
 lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(namespace,object_id)
);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due ON scheduled_jobs(due_at);
