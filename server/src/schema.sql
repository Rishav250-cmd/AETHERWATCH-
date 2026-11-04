CREATE TABLE IF NOT EXISTS spans (
  trace_id VARCHAR NOT NULL,
  span_id VARCHAR NOT NULL,
  parent_id VARCHAR,
  service VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  start_ts BIGINT NOT NULL,
  duration_ns BIGINT NOT NULL,
  status_code INTEGER,
  is_error BOOLEAN NOT NULL,
  attributes JSON,
  PRIMARY KEY (trace_id, span_id)
);

CREATE TABLE IF NOT EXISTS logs (
  ts BIGINT NOT NULL,
  service VARCHAR NOT NULL,
  level VARCHAR NOT NULL,
  message VARCHAR NOT NULL,
  trace_id VARCHAR,
  attributes JSON
);
