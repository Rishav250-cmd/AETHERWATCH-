import { createIdGenerator } from './ids.js';
import { createPrng } from './prng.js';
import { pickScenario } from './scenarios.js';
import { serviceDefinitions } from './services.js';

const nanosecondsPerMillisecond = 1_000_000n;
const nanosecondsPerSecond = 1_000_000_000n;
const lognormalSigma = 0.55;

function durationMsToNs(durationMs) {
  return BigInt(Math.max(1, Math.round(durationMs * 1_000_000)));
}

function parseEndTimeNs(endTimeNs) {
  if (endTimeNs === undefined) {
    return BigInt(Date.now()) * nanosecondsPerMillisecond;
  }
  if (typeof endTimeNs === 'bigint') {
    return endTimeNs;
  }
  if (typeof endTimeNs === 'string' && /^-?\d+$/.test(endTimeNs)) {
    return BigInt(endTimeNs);
  }
  throw new TypeError('endTimeNs must be a bigint or an integer string');
}

function randomBigIntBelow(prng, maxExclusive) {
  if (maxExclusive <= 0n) {
    throw new RangeError('random range must be positive');
  }

  if (maxExclusive === 1n) {
    return 0n;
  }

  const bitCount = (maxExclusive - 1n).toString(2).length;
  const wordCount = Math.ceil(bitCount / 32);
  const mask = (1n << BigInt(bitCount)) - 1n;

  while (true) {
    let value = 0n;
    for (let word = 0; word < wordCount; word += 1) {
      value = (value << 32n) | BigInt(prng.int(0, 0xffff_ffff));
    }
    value &= mask;
    if (value < maxExclusive) {
      return value;
    }
  }
}

function attributesFor(service, name, scenario) {
  const attributes = { host: serviceDefinitions[service].host };
  const httpOperation = /^(GET|POST|PUT|PATCH|DELETE) (\/.+)$/.exec(name);

  if (httpOperation) {
    attributes['http.method'] = httpOperation[1];
    attributes['http.route'] = httpOperation[2];
  }

  if (service === 'frontend') {
    attributes['http.method'] = scenario.method;
    attributes['http.route'] = scenario.route;
  }

  if (service === 'db') {
    attributes['db.system'] = 'postgresql';
    attributes['db.operation'] = name.split(' ', 1)[0];
  }

  return attributes;
}

function errorStatus(prng) {
  return prng.chance(0.35) ? 504 : 500;
}

function errorMessage(span) {
  if (span.status_code === 504) {
    return `upstream timeout after ${Math.round(Number(span.duration_ns) / 1_000_000)}ms`;
  }

  if (span.service === 'db') {
    return 'connection refused: ledger-db:5432';
  }
  if (span.service === 'payment') {
    return 'payment provider rejected the charge';
  }
  if (span.service === 'fraud-check') {
    return 'fraud scoring request failed';
  }
  if (span.service === 'cart') {
    return 'cart lookup failed';
  }
  if (span.service === 'notify') {
    return 'receipt delivery failed';
  }
  return 'request failed with status 500';
}

function formatDuration(durationNs) {
  const milliseconds = Number(durationNs) / 1_000_000;
  return Number(milliseconds.toFixed(1)).toString();
}

function validateTrace(spans) {
  const spanById = new Map(spans.map((span) => [span.span_id, span]));
  const seenIds = new Set();

  for (const span of spans) {
    if (seenIds.has(span.span_id)) {
      throw new Error(`Duplicate span_id ${span.span_id} within trace ${span.trace_id}`);
    }
    seenIds.add(span.span_id);

    if (span.parent_id === null) {
      continue;
    }

    const parent = spanById.get(span.parent_id);
    if (!parent) {
      throw new Error(`Missing parent ${span.parent_id} for span ${span.span_id}`);
    }

    const childEnd = span.start_ts + span.duration_ns;
    const parentEnd = parent.start_ts + parent.duration_ns;
    if (span.start_ts < parent.start_ts || childEnd > parentEnd) {
      throw new Error(`Span ${span.span_id} does not fit inside parent ${parent.span_id}`);
    }
  }
}

export function generate({
  traces = 1,
  seed = 1,
  faultService = null,
  faultStrength = 1,
  endTimeNs,
  spreadSeconds = 60,
} = {}) {
  if (!Number.isSafeInteger(traces) || traces < 0) {
    throw new RangeError('traces must be a non-negative safe integer');
  }
  if (faultService !== null && !Object.hasOwn(serviceDefinitions, faultService)) {
    throw new RangeError(`unknown faultService: ${faultService}`);
  }
  if (!Number.isFinite(faultStrength) || faultStrength < 0) {
    throw new RangeError('faultStrength must be a finite non-negative number');
  }
  if (!Number.isFinite(spreadSeconds) || spreadSeconds < 0) {
    throw new RangeError('spreadSeconds must be a finite non-negative number');
  }

  const spreadDurationNs = BigInt(Math.round(spreadSeconds * 1_000_000_000));
  const endTimestampNs = parseEndTimeNs(endTimeNs);
  const prng = createPrng(seed);
  const ids = createIdGenerator(prng);
  const spans = [];
  const metadataBySpanId = new Map();

  function buildSpan({ traceId, parentId, service, name, startTimestampNs, children, scenario }) {
    const definition = serviceDefinitions[service];
    const isFaulted = service === faultService;
    const latencyMultiplier = isFaulted ? 1 + (4 * faultStrength) : 1;
    const effectiveMedianMs = definition.baseMedianMs * latencyMultiplier;
    const errorRate = Math.min(
      1,
      isFaulted
        ? definition.baseErrorRate + ((0.15 - definition.baseErrorRate) * faultStrength)
        : definition.baseErrorRate,
    );
    const ownWorkMs = prng.lognormal(definition.baseMedianMs, lognormalSigma) * latencyMultiplier;
    const ownWorkNs = durationMsToNs(ownWorkMs);
    const spanId = ids.spanId();
    const localErrorStatus = prng.chance(errorRate) ? errorStatus(prng) : null;
    const span = {
      trace_id: traceId,
      span_id: spanId,
      parent_id: parentId,
      service,
      name,
      start_ts: startTimestampNs,
      duration_ns: ownWorkNs,
      status_code: localErrorStatus ?? 200,
      is_error: localErrorStatus !== null,
      attributes: attributesFor(service, name, scenario),
    };

    spans.push(span);
    metadataBySpanId.set(spanId, {
      ownWorkNs,
      effectiveMedianMs,
    });

    let elapsedNs = ownWorkNs;
    const failureStatuses = localErrorStatus === null ? [] : [localErrorStatus];

    for (let index = 0; index < children.length; index += 1) {
      if (index > 0) {
        const gapMs = 0.2 + (prng.next() * 1.8);
        elapsedNs += durationMsToNs(gapMs);
      }

      const childCall = children[index];
      const child = buildSpan({
        traceId,
        parentId: spanId,
        service: childCall.service,
        name: childCall.name,
        startTimestampNs: startTimestampNs + elapsedNs,
        children: childCall.children ?? [],
        scenario,
      });

      elapsedNs += child.duration_ns;
      if (child.is_error) {
        failureStatuses.push(child.status_code);
      }
    }

    span.duration_ns = elapsedNs;
    if (failureStatuses.length > 0) {
      span.is_error = true;
      span.status_code = failureStatuses.includes(504) ? 504 : 500;
    }

    return span;
  }

  for (let traceIndex = 0; traceIndex < traces; traceIndex += 1) {
    const scenario = pickScenario(prng);
    const traceId = ids.traceId();
    const startTimestampNs = endTimestampNs - randomBigIntBelow(prng, spreadDurationNs + 1n);
    const firstSpanIndex = spans.length;

    buildSpan({
      traceId,
      parentId: null,
      service: 'frontend',
      name: scenario.name,
      startTimestampNs,
      children: scenario.children,
      scenario,
    });

    const traceSpans = spans.slice(firstSpanIndex);
    validateTrace(traceSpans);
  }

  const logs = [];
  for (const span of spans) {
    const endTimestamp = span.start_ts + span.duration_ns;
    const duration = formatDuration(span.duration_ns);

    logs.push({
      ts: endTimestamp,
      service: span.service,
      level: 'INFO',
      message: `handled ${span.name} in ${duration}ms`,
      trace_id: span.trace_id,
      span_id: span.span_id,
      attributes: { status_code: span.status_code },
    });

    if (span.is_error) {
      logs.push({
        ts: endTimestamp,
        service: span.service,
        level: 'ERROR',
        message: errorMessage(span),
        trace_id: span.trace_id,
        span_id: span.span_id,
        attributes: { status_code: span.status_code },
      });
    }

    const spanMetadata = metadataBySpanId.get(span.span_id);
    const ownWorkMs = Number(spanMetadata.ownWorkNs) / 1_000_000;
    if (ownWorkMs > spanMetadata.effectiveMedianMs * 3) {
      logs.push({
        ts: endTimestamp,
        service: span.service,
        level: 'WARN',
        message: `slow operation: own work took ${formatDuration(spanMetadata.ownWorkNs)}ms`,
        trace_id: span.trace_id,
        span_id: span.span_id,
        attributes: { median_ms: spanMetadata.effectiveMedianMs },
      });
    }
  }

  return { spans, logs };
}
