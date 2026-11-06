import { generate } from '../src/generate.js';
import { toOtlpLogs, toOtlpTraces } from '../src/otlp.js';

const traceCount = 1_000;
const seed = 42;
const endTimeNs = 1_800_000_000_000_000_000n;
const spreadSeconds = 60;
const failures = [];

function fail(message) {
  throw new Error(message);
}

function check(label, action) {
  try {
    action();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonWithBigIntStrings(value) {
  return JSON.stringify(value, (_key, nestedValue) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  ));
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

function serviceMetrics(spans, service) {
  const serviceSpans = spans.filter((span) => span.service === service);
  if (serviceSpans.length === 0) {
    fail(`no spans found for service ${service}`);
  }

  const totalDurationNs = serviceSpans.reduce((total, span) => total + BigInt(span.duration_ns), 0n);
  const averageDurationMs = Number(totalDurationNs) / serviceSpans.length / 1_000_000;
  const errorRate = serviceSpans.filter((span) => span.is_error).length / serviceSpans.length;
  return { count: serviceSpans.length, averageDurationMs, errorRate };
}

function generateOptions(overrides = {}) {
  return {
    traces: traceCount,
    seed,
    endTimeNs,
    spreadSeconds,
    ...overrides,
  };
}

const healthy = generate(generateOptions());
let repeated;
let differentSeed;
let faulted;

check('a) every trace has exactly one root span', () => {
  for (const [traceId, traceSpans] of spansByTrace(healthy.spans)) {
    const rootCount = traceSpans.filter((span) => span.parent_id === null).length;
    if (rootCount !== 1) {
      fail(`${traceId} has ${rootCount} root spans`);
    }
  }
});

check('b) every non-root span has a parent in the same trace', () => {
  const indexes = new Map();
  for (const [traceId, traceSpans] of spansByTrace(healthy.spans)) {
    indexes.set(traceId, new Map(traceSpans.map((span) => [span.span_id, span])));
  }

  for (const span of healthy.spans) {
    if (span.parent_id !== null && !indexes.get(span.trace_id)?.has(span.parent_id)) {
      fail(`span ${span.span_id} has no parent ${span.parent_id} in trace ${span.trace_id}`);
    }
  }
});

check('c) each child starts and ends within its parent window', () => {
  for (const [traceId, traceSpans] of spansByTrace(healthy.spans)) {
    const index = new Map(traceSpans.map((span) => [span.span_id, span]));
    for (const span of traceSpans) {
      if (span.parent_id === null) {
        continue;
      }

      const parent = index.get(span.parent_id);
      const childStart = BigInt(span.start_ts);
      const childEnd = childStart + BigInt(span.duration_ns);
      const parentStart = BigInt(parent.start_ts);
      const parentEnd = parentStart + BigInt(parent.duration_ns);
      if (childStart < parentStart || childEnd > parentEnd) {
        fail(`span ${span.span_id} falls outside parent ${parent.span_id}`);
      }
    }
  }
});

check('d) span IDs are unique and IDs use the required lowercase hex lengths', () => {
  const spanIds = new Set();
  for (const span of healthy.spans) {
    if (!/^[0-9a-f]{32}$/.test(span.trace_id)) {
      fail(`invalid trace_id ${span.trace_id}`);
    }
    if (!/^[0-9a-f]{16}$/.test(span.span_id)) {
      fail(`invalid span_id ${span.span_id}`);
    }
    if (spanIds.has(span.span_id)) {
      fail(`duplicate span_id ${span.span_id}`);
    }
    spanIds.add(span.span_id);
  }
});

check('e) errors propagate from every failed span to its parent', () => {
  const spanByTraceAndId = new Map(healthy.spans.map((span) => [
    `${span.trace_id}:${span.span_id}`,
    span,
  ]));

  for (const span of healthy.spans) {
    if (!span.is_error || span.parent_id === null) {
      continue;
    }

    const parent = spanByTraceAndId.get(`${span.trace_id}:${span.parent_id}`);
    if (!parent?.is_error) {
      fail(`error span ${span.span_id} has a healthy parent`);
    }
  }
});

check('f) same seed repeats exactly and a different seed changes output', () => {
  repeated = generate(generateOptions());
  differentSeed = generate(generateOptions({ seed: seed + 1 }));
  if (jsonWithBigIntStrings(healthy) !== jsonWithBigIntStrings(repeated)) {
    fail('same seed produced different spans or logs');
  }
  if (jsonWithBigIntStrings(healthy) === jsonWithBigIntStrings(differentSeed)) {
    fail('different seed produced identical spans and logs');
  }
});

check('g) payment fault raises payment latency and errors while other services remain stable', () => {
  faulted = generate(generateOptions({ faultService: 'payment', faultStrength: 1 }));
  const healthyPayment = serviceMetrics(healthy.spans, 'payment');
  const faultedPayment = serviceMetrics(faulted.spans, 'payment');

  if (faultedPayment.averageDurationMs < healthyPayment.averageDurationMs * 3) {
    fail(`payment latency rose ${(faultedPayment.averageDurationMs / healthyPayment.averageDurationMs).toFixed(2)}x, expected at least 3x`);
  }
  if (faultedPayment.errorRate < healthyPayment.errorRate * 5) {
    fail(`payment error rate rose ${(faultedPayment.errorRate / healthyPayment.errorRate).toFixed(2)}x, expected at least 5x`);
  }

  // Frontend spans include payment's child time and propagated errors, so their
  // aggregate values should rise with the injected downstream fault.
  for (const service of ['cart', 'fraud-check', 'db', 'notify']) {
    const healthyMetrics = serviceMetrics(healthy.spans, service);
    const faultedMetrics = serviceMetrics(faulted.spans, service);
    const durationRatio = faultedMetrics.averageDurationMs / healthyMetrics.averageDurationMs;
    const errorRateDifference = Math.abs(faultedMetrics.errorRate - healthyMetrics.errorRate);
    if (durationRatio < 0.75 || durationRatio > 1.25) {
      fail(`${service} average duration changed by more than 25%`);
    }
    if (errorRateDifference > 0.02) {
      fail(`${service} error rate changed by more than 2 percentage points`);
    }
  }
});

check('h) OTLP timestamps are strings, JSON round-trips, and span count is preserved', () => {
  const tracesPayload = toOtlpTraces(healthy.spans);
  const logsPayload = toOtlpLogs(healthy.logs);
  const parsedTraces = JSON.parse(JSON.stringify(tracesPayload));
  const parsedLogs = JSON.parse(JSON.stringify(logsPayload));

  let otlpSpanCount = 0;
  for (const resourceSpan of parsedTraces.resourceSpans) {
    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        otlpSpanCount += 1;
        if (typeof span.startTimeUnixNano !== 'string' || typeof span.endTimeUnixNano !== 'string') {
          fail('an OTLP span timestamp is not a string');
        }
        const statusAttribute = span.attributes.find((attribute) => attribute.key === 'http.status_code');
        if (!statusAttribute || typeof statusAttribute.value.intValue !== 'string') {
          fail('an OTLP http.status_code intValue is not a string');
        }
      }
    }
  }

  for (const resourceLog of parsedLogs.resourceLogs) {
    for (const scopeLog of resourceLog.scopeLogs) {
      for (const logRecord of scopeLog.logRecords) {
        if (typeof logRecord.timeUnixNano !== 'string') {
          fail('an OTLP log timestamp is not a string');
        }
      }
    }
  }

  if (otlpSpanCount !== healthy.spans.length) {
    fail(`OTLP contains ${otlpSpanCount} spans; flat data has ${healthy.spans.length}`);
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} validation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll validation checks passed.');
}
