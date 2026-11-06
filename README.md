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
