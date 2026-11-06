import { all, close, run } from '../src/db.js';

const nanosecondsPerMillisecond = 1_000_000n;
const baseTimestamp = BigInt(Date.now()) * nanosecondsPerMillisecond;

function timestampAt(offsetMs) {
  return baseTimestamp + BigInt(offsetMs) * nanosecondsPerMillisecond;
}

function durationInNanoseconds(durationMs) {
  return BigInt(durationMs) * nanosecondsPerMillisecond;
}

function makeSpan({
  traceId,
  spanId,
  parentId = null,
  service,
  name,
  startOffsetMs,
  durationMs,
  statusCode = 200,
  isError = false,
  attributes = {},
}) {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId,
    service,
    name,
    start_ts: timestampAt(startOffsetMs),
    duration_ns: durationInNanoseconds(durationMs),
    status_code: statusCode,
    is_error: isError,
    attributes: JSON.stringify(attributes),
  };
}

const traceIds = {
  healthy: 'aetherwatch-trace-001',
  slow: 'aetherwatch-trace-002',
  failed: 'aetherwatch-trace-003',
};

const spans = [
  // Trace 1: healthy request through cart, payment, fraud check, database, and notification.
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-root', service: 'frontend', name: 'POST /checkout', startOffsetMs: 0, durationMs: 1_000, attributes: { 'http.method': 'POST', 'http.route': '/checkout' } }),
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-cart', parentId: 't1-root', service: 'cart', name: 'cart.create_order', startOffsetMs: 20, durationMs: 500 }),
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-payment', parentId: 't1-cart', service: 'payment', name: 'payment.authorize', startOffsetMs: 70, durationMs: 25, attributes: { 'payment.provider': 'acme-pay' } }),
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-fraud', parentId: 't1-payment', service: 'fraud-check', name: 'fraud.evaluate', startOffsetMs: 74, durationMs: 8 }),
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-db', parentId: 't1-payment', service: 'db', name: 'payments.insert', startOffsetMs: 80, durationMs: 6, attributes: { 'db.system': 'postgresql', 'db.operation': 'INSERT' } }),
  makeSpan({ traceId: traceIds.healthy, spanId: 't1-notify', parentId: 't1-root', service: 'notify', name: 'order_confirmation.enqueue', startOffsetMs: 800, durationMs: 18 }),

  // Trace 2: healthy request with payment taking 450 ms, eighteen times longer than trace 1.
  makeSpan({ traceId: traceIds.slow, spanId: 't2-root', service: 'frontend', name: 'POST /checkout', startOffsetMs: 2_000, durationMs: 1_200, attributes: { 'http.method': 'POST', 'http.route': '/checkout' } }),
  makeSpan({ traceId: traceIds.slow, spanId: 't2-cart', parentId: 't2-root', service: 'cart', name: 'cart.create_order', startOffsetMs: 2_020, durationMs: 600 }),
  makeSpan({ traceId: traceIds.slow, spanId: 't2-payment', parentId: 't2-cart', service: 'payment', name: 'payment.authorize', startOffsetMs: 2_070, durationMs: 450, attributes: { 'payment.provider': 'acme-pay' } }),
  makeSpan({ traceId: traceIds.slow, spanId: 't2-fraud', parentId: 't2-payment', service: 'fraud-check', name: 'fraud.evaluate', startOffsetMs: 2_074, durationMs: 12 }),
  makeSpan({ traceId: traceIds.slow, spanId: 't2-db', parentId: 't2-payment', service: 'db', name: 'payments.insert', startOffsetMs: 2_300, durationMs: 9, attributes: { 'db.system': 'postgresql', 'db.operation': 'INSERT' } }),
  makeSpan({ traceId: traceIds.slow, spanId: 't2-notify', parentId: 't2-root', service: 'notify', name: 'order_confirmation.enqueue', startOffsetMs: 2_800, durationMs: 20 }),

  // Trace 3: the payment request times out and its database write fails.
  makeSpan({ traceId: traceIds.failed, spanId: 't3-root', service: 'frontend', name: 'POST /checkout', startOffsetMs: 4_000, durationMs: 1_000, statusCode: 504, isError: true, attributes: { 'http.method': 'POST', 'http.route': '/checkout' } }),
  makeSpan({ traceId: traceIds.failed, spanId: 't3-cart', parentId: 't3-root', service: 'cart', name: 'cart.create_order', startOffsetMs: 4_020, durationMs: 500 }),
  makeSpan({ traceId: traceIds.failed, spanId: 't3-payment', parentId: 't3-cart', service: 'payment', name: 'payment.authorize', startOffsetMs: 4_070, durationMs: 180, statusCode: 504, isError: true, attributes: { 'payment.provider': 'acme-pay' } }),
  makeSpan({ traceId: traceIds.failed, spanId: 't3-fraud', parentId: 't3-payment', service: 'fraud-check', name: 'fraud.evaluate', startOffsetMs: 4_074, durationMs: 10 }),
  makeSpan({ traceId: traceIds.failed, spanId: 't3-db', parentId: 't3-payment', service: 'db', name: 'payments.insert', startOffsetMs: 4_100, durationMs: 12, statusCode: 500, isError: true, attributes: { 'db.system': 'postgresql', 'db.operation': 'INSERT' } }),
  makeSpan({ traceId: traceIds.failed, spanId: 't3-notify', parentId: 't3-root', service: 'notify', name: 'order_failure.enqueue', startOffsetMs: 4_800, durationMs: 18 }),
];

const logs = [
  { offsetMs: 75, service: 'frontend', level: 'INFO', message: 'Checkout request received', trace_id: traceIds.healthy, attributes: { 'http.route': '/checkout' } },
  { offsetMs: 96, service: 'payment', level: 'INFO', message: 'Payment authorization approved', trace_id: traceIds.healthy, attributes: { 'payment.result': 'approved' } },
  { offsetMs: 825, service: 'notify', level: 'INFO', message: 'Order confirmation queued', trace_id: traceIds.healthy, attributes: {} },
  { offsetMs: 2_075, service: 'frontend', level: 'INFO', message: 'Checkout request received', trace_id: traceIds.slow, attributes: { 'http.route': '/checkout' } },
  { offsetMs: 2_250, service: 'payment', level: 'WARN', message: 'Payment provider response is slower than usual', trace_id: traceIds.slow, attributes: { 'payment.elapsed_ms': 180 } },
  { offsetMs: 2_525, service: 'payment', level: 'INFO', message: 'Payment authorization approved after retry', trace_id: traceIds.slow, attributes: { 'payment.result': 'approved', 'payment.elapsed_ms': 450 } },
  { offsetMs: 4_075, service: 'frontend', level: 'INFO', message: 'Checkout request received', trace_id: traceIds.failed, attributes: { 'http.route': '/checkout' } },
  { offsetMs: 4_190, service: 'payment', level: 'ERROR', message: 'Payment authorization timed out with status 504', trace_id: traceIds.failed, attributes: { 'http.status_code': 504 } },
  { offsetMs: 4_192, service: 'payment', level: 'ERROR', message: 'Payment database write failed with status 500', trace_id: traceIds.failed, attributes: { 'db.status_code': 500 } },
  { offsetMs: 4_195, service: 'payment', level: 'ERROR', message: 'Checkout payment attempt failed', trace_id: traceIds.failed, attributes: { 'payment.result': 'failed' } },
].map(({ offsetMs, ...log }) => ({
  ...log,
  ts: timestampAt(offsetMs),
  attributes: JSON.stringify(log.attributes),
}));

function validateChildWindows() {
  const spanById = new Map(spans.map((span) => [`${span.trace_id}:${span.span_id}`, span]));

  for (const span of spans) {
    if (span.parent_id === null) {
      continue;
    }

    const parent = spanById.get(`${span.trace_id}:${span.parent_id}`);
    if (!parent) {
      throw new Error(`Missing parent ${span.parent_id} for span ${span.span_id}`);
    }

    const parentEnd = parent.start_ts + parent.duration_ns;
    if (span.start_ts < parent.start_ts || span.start_ts > parentEnd) {
      throw new Error(`Span ${span.span_id} starts outside its parent window`);
    }
  }
}

const insertSpanSql = `
  INSERT INTO spans (
    trace_id, span_id, parent_id, service, name,
    start_ts, duration_ns, status_code, is_error, attributes
  ) VALUES (
    $trace_id, $span_id, $parent_id, $service, $name,
    $start_ts, $duration_ns, $status_code, $is_error, CAST($attributes AS JSON)
  )
`;

const insertLogSql = `
  INSERT INTO logs (ts, service, level, message, trace_id, attributes)
  VALUES ($ts, $service, $level, $message, $trace_id, CAST($attributes AS JSON))
`;

try {
  validateChildWindows();
  await run('DELETE FROM spans');
  await run('DELETE FROM logs');

  for (const span of spans) {
    await run(insertSpanSql, span);
  }

  for (const log of logs) {
    await run(insertLogSql, log);
  }

  const [spanCount, logCount] = await Promise.all([
    all('SELECT COUNT(*) AS count FROM spans'),
    all('SELECT COUNT(*) AS count FROM logs'),
  ]);

  console.log(`Inserted ${spanCount[0].count} spans and ${logCount[0].count} logs.`);
} finally {
  await close();
}
