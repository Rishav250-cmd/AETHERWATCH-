import Fastify from 'fastify';
import { createGunzip } from 'node:zlib';
import { all, close as closeDatabase, getConnection } from './db.js';
import { BatchBuffer } from './ingest/buffer.js';
import { parseOtlpLogs } from './ingest/parseLogs.js';
import { parseOtlpTraces } from './ingest/parseTraces.js';
import { writeLogs, writeSpans } from './ingest/writer.js';

const LOCK_MESSAGE = 'Database is locked. Stop any other process (db:check, db:reset, another server) using data/aetherwatch.duckdb.';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const fastify = Fastify({
  logger: true,
  bodyLimit: MAX_BODY_BYTES,
});
const processStartedAt = Date.now();
let rejectedSpans = 0;
let rejectedLogRecords = 0;
let writtenSpanCount = 0;
let shutdownPromise;

const buffer = new BatchBuffer({
  maxItems: 1000,
  flushIntervalMs: 1000,
  maxQueued: 200000,
  onFlush: async (spansBatch, logsBatch) => {
    if (spansBatch.length > 0) {
      writtenSpanCount += await writeSpans(spansBatch);
    }
    if (logsBatch.length > 0) {
      await writeLogs(logsBatch);
    }
  },
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validOtlpTracesShape(payload) {
  return isRecord(payload)
    && Array.isArray(payload.resourceSpans)
    && payload.resourceSpans.every((resourceSpan) => (
      isRecord(resourceSpan)
      && Array.isArray(resourceSpan.scopeSpans)
      && resourceSpan.scopeSpans.every((scopeSpan) => (
        isRecord(scopeSpan) && Array.isArray(scopeSpan.spans)
      ))
    ));
}

function validOtlpLogsShape(payload) {
  return isRecord(payload)
    && Array.isArray(payload.resourceLogs)
    && payload.resourceLogs.every((resourceLog) => (
      isRecord(resourceLog)
      && Array.isArray(resourceLog.scopeLogs)
      && resourceLog.scopeLogs.every((scopeLog) => (
        isRecord(scopeLog) && Array.isArray(scopeLog.logRecords)
      ))
    ));
}

function isIngestRoute(url) {
  const pathname = url.split('?', 1)[0];
  return pathname === '/v1/traces' || pathname === '/v1/logs';
}

fastify.addHook('onRequest', async (request, reply) => {
  if (!isIngestRoute(request.url)) {
    return;
  }

  const contentType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return reply.code(415).send({ error: 'Only OTLP/HTTP JSON is supported; use Content-Type: application/json.' });
  }

  const contentEncoding = String(request.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity' && contentEncoding !== 'gzip') {
    return reply.code(415).send({ error: 'Only uncompressed or gzip-compressed OTLP/HTTP JSON is supported.' });
  }
});

fastify.addHook('preParsing', async (request, _reply, payload) => {
  const contentEncoding = String(request.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (contentEncoding !== 'gzip') {
    return payload;
  }

  const gunzip = createGunzip();
  Object.defineProperty(gunzip, 'receivedEncodedLength', {
    get() {
      return gunzip.bytesWritten;
    },
  });
  payload.pipe(gunzip);
  return gunzip;
});

fastify.setErrorHandler((error, request, reply) => {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  fastify.log.error({ err: error, requestUrl: request.url }, 'Request failed');

  const message = statusCode === 400
    ? 'Invalid JSON request body.'
    : statusCode === 413
      ? 'Request body exceeds the 32 MB limit.'
      : statusCode >= 500
        ? 'Internal server error.'
        : error.message;
  reply.code(statusCode).send({ error: message });
});

fastify.get('/health', async () => ({
  status: 'ok',
  uptimeSec: Number(process.uptime().toFixed(3)),
}));

fastify.get('/api/ingest/stats', async () => {
  const stats = buffer.stats();
  const uptimeSeconds = Math.max((Date.now() - processStartedAt) / 1000, 0.001);
  return {
    ...stats,
    rejectedSpans,
    rejectedLogRecords,
    writtenSpans: writtenSpanCount,
    spansPerSec: Number((writtenSpanCount / uptimeSeconds).toFixed(2)),
  };
});

fastify.get('/api/debug/counts', async () => {
  const [counts] = await all(`
    SELECT
      (SELECT count(*) FROM spans) AS spans,
      (SELECT count(*) FROM logs) AS logs
  `);
  return { spans: Number(counts.spans), logs: Number(counts.logs) };
});

fastify.post('/v1/traces', { logLevel: 'silent' }, async (request, reply) => {
  if (!validOtlpTracesShape(request.body)) {
    return reply.code(400).send({ error: 'Invalid OTLP traces JSON shape; expected resourceSpans[].scopeSpans[].spans[].' });
  }

  const parsed = parseOtlpTraces(request.body);
  rejectedSpans += parsed.rejected;
  if (!buffer.add('spans', parsed.rows)) {
    return reply.header('Retry-After', '1').code(429).send({ error: 'Ingestion buffer is full; retry after 1 second.' });
  }

  if (parsed.rejected > 0) {
    return reply.code(200).send({
      partialSuccess: {
        rejectedSpans: parsed.rejected,
        errorMessage: `Rejected ${parsed.rejected} malformed spans.`,
      },
    });
  }
  return reply.code(200).send({});
});

fastify.post('/v1/logs', { logLevel: 'silent' }, async (request, reply) => {
  if (!validOtlpLogsShape(request.body)) {
    return reply.code(400).send({ error: 'Invalid OTLP logs JSON shape; expected resourceLogs[].scopeLogs[].logRecords[].' });
  }

  const parsed = parseOtlpLogs(request.body);
  rejectedLogRecords += parsed.rejected;
  if (!buffer.add('logs', parsed.rows)) {
    return reply.header('Retry-After', '1').code(429).send({ error: 'Ingestion buffer is full; retry after 1 second.' });
  }

  if (parsed.rejected > 0) {
    return reply.code(200).send({
      partialSuccess: {
        rejectedLogRecords: parsed.rejected,
        errorMessage: `Rejected ${parsed.rejected} malformed log records.`,
      },
    });
  }
  return reply.code(200).send({});
});

async function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    fastify.log.info({ signal }, 'Stopping ingestion server');
    await fastify.close();
    const writtenBeforeClose = buffer.stats().written;
    await buffer.close();
    const flushedOnShutdown = buffer.stats().written - writtenBeforeClose;
    fastify.log.info(`Flushed ${flushedOnShutdown} rows during shutdown.`);
    await closeDatabase();
  })().catch((error) => {
    fastify.log.error({ err: error }, 'Graceful shutdown failed');
    process.exitCode = 1;
  });

  return shutdownPromise;
}

async function main() {
  try {
    await getConnection();
    const port = Number(process.env.PORT ?? 4318);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`AetherWatch ingestion server listening on 0.0.0.0:${port}`);
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/lock|locked|being used|conflicting/i.test(message)) {
      fastify.log.error(LOCK_MESSAGE);
    }
    fastify.log.error({ err: error }, 'Could not start ingestion server');
    try {
      await buffer.close();
    } catch (closeError) {
      fastify.log.error({ err: closeError }, 'Could not close ingestion buffer after startup failure');
    }
    process.exitCode = 1;
  }
}

await main();
