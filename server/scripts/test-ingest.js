import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../../generator/src/generate.js';
import { toOtlpLogs, toOtlpTraces } from '../../generator/src/otlp.js';
import { parseOtlpLogs } from '../src/ingest/parseLogs.js';
import { parseOtlpTraces } from '../src/ingest/parseTraces.js';
import { BatchBuffer } from '../src/ingest/buffer.js';

const failures = [];

function fail(message) {
  throw new Error(message);
}

async function check(label, action) {
  try {
    await action();
    console.log(`PASS ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ label, message });
    console.log(`FAIL ${label}: ${message}`);
  }
}

function spansByTrace(spans) {
  const grouped = new Map();
  for (const span of spans) {
    const traceSpans = grouped.get(span.trace_id) ?? [];
    traceSpans.push(span);
    grouped.set(span.trace_id, traceSpans);
  }
  return grouped;
}

function findAnySpan(payload) {
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      if (scopeSpan.spans?.length) {
        return scopeSpan.spans[0];
      }
    }
  }
  fail('generated OTLP payload contained no spans');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'aetherwatch-ingest-'));
  let closeDatabase;

  try {
    const generated = generate({
      traces: 200,
      seed: 7,
      endTimeNs: 1_800_000_000_000_000_000n,
    });
    const tracesPayload = toOtlpTraces(generated.spans);
    const logsPayload = toOtlpLogs(generated.logs);
    const parsedSpans = parseOtlpTraces(tracesPayload);
    const parsedLogs = parseOtlpLogs(logsPayload);

    await check('parses generated spans and logs with no rejects', () => {
      if (parsedSpans.rows.length !== generated.spans.length) {
        fail(`parsed ${parsedSpans.rows.length} spans; generated ${generated.spans.length}`);
      }
      if (parsedLogs.rows.length !== generated.logs.length) {
        fail(`parsed ${parsedLogs.rows.length} logs; generated ${generated.logs.length}`);
      }
      if (parsedSpans.rejected !== 0 || parsedLogs.rejected !== 0) {
        fail(`rejected ${parsedSpans.rejected} spans and ${parsedLogs.rejected} logs`);
      }
    });

    await check('parsed timestamps are BigInts and span statuses match', () => {
      if (!parsedSpans.rows.every((row) => typeof row.start_ts === 'bigint' && typeof row.duration_ns === 'bigint')) {
        fail('a parsed span timestamp or duration is not a BigInt');
      }
      if (!parsedLogs.rows.every((row) => typeof row.ts === 'bigint')) {
        fail('a parsed log timestamp is not a BigInt');
      }

      const generatedById = new Map(generated.spans.map((span) => [`${span.trace_id}:${span.span_id}`, span]));
      for (const row of parsedSpans.rows) {
        const original = generatedById.get(`${row.trace_id}:${row.span_id}`);
        if (!original || row.is_error !== original.is_error || row.status_code !== original.status_code) {
          fail(`status mismatch for span ${row.span_id}`);
        }
      }
    });

    await check('counts malformed spans and continues parsing valid spans', () => {
      const validSpan = findAnySpan(tracesPayload);
      const badTimestamp = { ...validSpan, startTimeUnixNano: 'not-a-timestamp' };
      const { spanId: ignoredSpanId, ...missingSpanId } = validSpan;
      void ignoredSpanId;
      const malformedPayload = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test-service' } }] },
            scopeSpans: [{ spans: [validSpan, badTimestamp, missingSpanId] }],
          },
        ],
      };
      const result = parseOtlpTraces(malformedPayload);
      if (result.rows.length !== 1 || result.rejected !== 2) {
        fail(`expected one parsed span and two rejects; got ${result.rows.length} and ${result.rejected}`);
      }
    });

    await check('buffer flushes 2,500 rows in batches of at most 1,000', async () => {
      const batches = [];
      const buffer = new BatchBuffer({
        maxItems: 1000,
        flushIntervalMs: 1000,
        maxQueued: 10000,
        onFlush: async (spansBatch, logsBatch) => {
          batches.push({ spans: spansBatch.length, logs: logsBatch.length });
        },
      });
      const rows = Array.from({ length: 2500 }, (_, index) => ({ index }));
      if (!buffer.add('spans', rows)) {
        fail('buffer rejected 2,500 rows below maxQueued');
      }
      await buffer.close();

      const flushedCount = batches.reduce((total, batch) => total + batch.spans, 0);
      if (flushedCount !== 2500 || batches.some((batch) => batch.spans > 1000)) {
        fail(`flushed ${flushedCount} rows with batch sizes ${batches.map((batch) => batch.spans).join(', ')}`);
      }
    });

    await check('buffer timer flushes partial batches and close flushes leftovers', async () => {
      const batches = [];
      const buffer = new BatchBuffer({
        maxItems: 1000,
        flushIntervalMs: 1000,
        onFlush: async (spansBatch, logsBatch) => {
          batches.push({ spans: spansBatch.length, logs: logsBatch.length });
        },
      });
      buffer.add('spans', [{ id: 'timer' }]);
      await delay(1100);
      const timerFlushed = batches.some((batch) => batch.spans === 1);
      buffer.add('logs', [{ id: 'close' }]);
      await buffer.close();
      const closeFlushed = batches.some((batch) => batch.logs === 1);
      if (!timerFlushed || !closeFlushed) {
        fail(`timer flush=${timerFlushed}, close flush=${closeFlushed}`);
      }
    });

    await check('buffer rejects additions above maxQueued', async () => {
      const buffer = new BatchBuffer({
        maxItems: 1000,
        flushIntervalMs: 1000,
        maxQueued: 2,
        onFlush: async () => {},
      });
      const accepted = buffer.add('spans', [{}, {}]);
      const rejected = buffer.add('logs', [{}]);
      await buffer.close();
      if (!accepted || rejected || buffer.stats().received !== 2) {
        fail(`accepted=${accepted}, rejected=${rejected}, received=${buffer.stats().received}`);
      }
    });

    await check('writer uses a temporary database, ignores duplicate spans, and supports trace joins', async () => {
      const { close, getConnection, run, all, setDatabasePath } = await import('../src/db.js');
      const { writeLogs, writeSpans } = await import('../src/ingest/writer.js');
      closeDatabase = close;
      setDatabasePath(join(tempDirectory, 'ingest-test.duckdb'));

      const schema = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
      for (const statement of schema.split(';').map((sql) => sql.trim()).filter(Boolean)) {
        await run(statement);
      }
      await getConnection();

      const writtenSpans = await writeSpans(parsedSpans.rows);
      const writtenLogs = await writeLogs(parsedLogs.rows);
      const firstSpanCount = Number((await all('SELECT count(*) AS count FROM spans'))[0].count);
      const logCount = Number((await all('SELECT count(*) AS count FROM logs'))[0].count);
      if (writtenSpans !== parsedSpans.rows.length || firstSpanCount !== parsedSpans.rows.length) {
        fail(`wrote ${writtenSpans}, table contains ${firstSpanCount}, expected ${parsedSpans.rows.length} spans`);
      }
      if (writtenLogs !== parsedLogs.rows.length || logCount !== parsedLogs.rows.length) {
        fail(`wrote ${writtenLogs}, table contains ${logCount}, expected ${parsedLogs.rows.length} logs`);
      }

      const duplicateWriteCount = await writeSpans(parsedSpans.rows);
      const afterDuplicateCount = Number((await all('SELECT count(*) AS count FROM spans'))[0].count);
      if (duplicateWriteCount !== 0 || afterDuplicateCount !== firstSpanCount) {
        fail(`duplicate write inserted ${duplicateWriteCount} rows; count changed to ${afterDuplicateCount}`);
      }

      const tree = await all(`
        SELECT child.trace_id, child.span_id, parent.span_id AS parent_id
        FROM spans AS child
        JOIN spans AS parent
          ON parent.trace_id = child.trace_id
         AND parent.span_id = child.parent_id
        LIMIT 1
      `);
      if (tree.length !== 1) {
        fail('trace tree join returned no parent-child rows');
      }
    });
  } finally {
    try {
      if (closeDatabase) {
        await closeDatabase();
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} ingest check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll ingestion checks passed.');
  }
}

await main();
