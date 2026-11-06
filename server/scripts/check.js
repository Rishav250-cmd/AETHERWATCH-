import { all, close } from '../src/db.js';

const expectedSpanCount = 18;
const expectedLogCount = 10;
const traceOneId = 'aetherwatch-trace-001';
const traceThreeId = 'aetherwatch-trace-003';

function durationMs(value) {
  return Number(value).toFixed(3);
}

function printRows(headers, rows, formatRow) {
  console.log(headers.join(' | '));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

try {
  const [spanCountRows, logCountRows] = await Promise.all([
    all('SELECT COUNT(*) AS count FROM spans'),
    all('SELECT COUNT(*) AS count FROM logs'),
  ]);
  const spanCount = Number(spanCountRows[0].count);
  const logCount = Number(logCountRows[0].count);

  console.log('=== Row counts ===');
  console.log(`spans: ${spanCount}`);
  console.log(`logs: ${logCount}`);

  const traceOneSpans = await all(`
    SELECT service, name, parent_id, duration_ns / 1000000.0 AS duration_ms
    FROM spans
    WHERE trace_id = $trace_id
    ORDER BY start_ts
  `, { trace_id: traceOneId });

  console.log('\n=== Trace 1 spans (ordered by start_ts) ===');
  printRows(
    ['service', 'name', 'parent_id', 'duration_ms'],
    traceOneSpans,
    (span) => `${span.service} | ${span.name} | ${span.parent_id ?? 'NULL'} | ${durationMs(span.duration_ms)}`,
  );

  const traceThreeTree = await all(`
    WITH RECURSIVE trace_tree AS (
      SELECT
        trace_id,
        span_id,
        parent_id,
        service,
        name,
        start_ts,
        duration_ns,
        0 AS depth,
        LPAD(CAST(start_ts AS VARCHAR), 20, '0') AS sort_path
      FROM spans
      WHERE trace_id = $trace_id AND parent_id IS NULL

      UNION ALL

      SELECT
        child.trace_id,
        child.span_id,
        child.parent_id,
        child.service,
        child.name,
        child.start_ts,
        child.duration_ns,
        parent.depth + 1 AS depth,
        parent.sort_path || '/' || LPAD(CAST(child.start_ts AS VARCHAR), 20, '0') AS sort_path
      FROM spans AS child
      JOIN trace_tree AS parent
        ON child.trace_id = parent.trace_id
       AND child.parent_id = parent.span_id
    )
    SELECT depth, service, name, duration_ns / 1000000.0 AS duration_ms
    FROM trace_tree
    ORDER BY sort_path
  `, { trace_id: traceThreeId });

  console.log('\n=== Trace 3 span tree ===');
  for (const span of traceThreeTree) {
    const indentation = '  '.repeat(Number(span.depth));
    console.log(`${indentation}${span.service} | ${span.name} | ${durationMs(span.duration_ms)} ms`);
  }

  const serviceErrors = await all(`
    SELECT
      service,
      COUNT(*) FILTER (WHERE is_error) AS error_count,
      AVG(duration_ns) / 1000000.0 AS avg_duration_ms
    FROM spans
    GROUP BY service
    ORDER BY service
  `);

  console.log('\n=== Error count and average duration by service ===');
  printRows(
    ['service', 'error_count', 'avg_duration_ms'],
    serviceErrors,
    (row) => `${row.service} | ${row.error_count} | ${durationMs(row.avg_duration_ms)}`,
  );

  const errorLogs = await all(`
    SELECT
      logs.trace_id,
      root.name AS root_span_name,
      logs.service,
      logs.message
    FROM logs
    JOIN spans AS root
      ON root.trace_id = logs.trace_id
     AND root.parent_id IS NULL
    WHERE upper(logs.level) = 'ERROR'
    ORDER BY logs.ts
  `);

  console.log('\n=== ERROR logs and trace root spans ===');
  printRows(
    ['trace_id', 'root_span_name', 'service', 'message'],
    errorLogs,
    (log) => `${log.trace_id} | ${log.root_span_name} | ${log.service} | ${log.message}`,
  );

  if (spanCount !== expectedSpanCount || logCount !== expectedLogCount) {
    console.error(
      `ERROR: Seed count mismatch; expected ${expectedSpanCount} spans and ${expectedLogCount} logs, found ${spanCount} spans and ${logCount} logs.`,
    );
    process.exitCode = 1;
  }
} finally {
  await close();
}
