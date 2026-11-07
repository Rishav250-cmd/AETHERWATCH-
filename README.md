# AetherWatch

AetherWatch is a small distributed observability project with a DuckDB-backed store for sample traces and logs, including scripts to initialize, reset, seed, and inspect the data.

## Prerequisites

- Node.js 20 or newer

DuckDB is embedded in the application and needs no account or separate database server.

## Setup

```sh
npm install
npm run db:reset
npm run db:check
```

## Generator

The synthetic load generator builds repeatable microservice traces and correlated logs, then writes OTLP/JSON and flat JSON files under `generator/out/` by default. Run a healthy batch or inject a payment fault with:

```sh
npm run gen -- --traces 1000
npm run gen:fault
```

## Ingestion

Initialize the DuckDB schema, then start the ingestion server:

```sh
npm run db:init
npm run server:start
```

The server listens on port `4318` by default (`PORT` can override it) and accepts OTLP/HTTP JSON at `POST /v1/traces` and `POST /v1/logs`. Gzip-compressed JSON is also supported. To send a batch, run `npm run gen:send`; use `npm run gen:live` for continuous traffic or `npm run gen:live:fault` to inject a payment fault. The generator accepts `--batch` and `--concurrency` to tune request sizes and parallelism.

For a direct OTLP/JSON request, use:

```sh
curl -X POST http://localhost:4318/v1/traces -H 'Content-Type: application/json' --data-binary @generator/out/traces.json
```

Stop the server before running `npm run db:check` or `npm run db:reset`; DuckDB locks its database file while the server is open. If another process holds the lock, stop it before restarting the server.
