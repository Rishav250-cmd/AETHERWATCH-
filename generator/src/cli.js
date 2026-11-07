import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { generate } from './generate.js';
import { toOtlpLogs, toOtlpTraces } from './otlp.js';

const { values } = parseArgs({
  options: {
    traces: { type: 'string', default: ['100'], multiple: true },
    seed: { type: 'string', default: '42' },
    fault: { type: 'string' },
    strength: { type: 'string', default: '1' },
    spread: { type: 'string', default: '60' },
    out: { type: 'string', default: 'generator/out' },
    send: { type: 'string' },
    batch: { type: 'string', default: '100' },
    concurrency: { type: 'string', default: '4' },
    continuous: { type: 'boolean', default: false },
    rate: { type: 'string', default: '20' },
  },
  allowPositionals: false,
  strict: true,
});

const retryLimit = 5;

function parseIntegerOption(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`--${name} must be a safe integer`);
  }
  return parsed;
}

function parseNumberOption(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`--${name} must be a finite number`);
  }
  return parsed;
}

function stringifyJson(value) {
  return `${JSON.stringify(value, (_key, nestedValue) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  ), 2)}\n`;
}

function summarize(spans, logs) {
  const traceCount = new Set(spans.map((span) => span.trace_id)).size;
  const errorSpanCount = spans.filter((span) => span.is_error).length;
  const serviceStats = new Map();

  for (const span of spans) {
    const stats = serviceStats.get(span.service) ?? {
      count: 0,
      durationNs: 0n,
      errorCount: 0,
    };
    stats.count += 1;
    stats.durationNs += BigInt(span.duration_ns);
    if (span.is_error) {
      stats.errorCount += 1;
    }
    serviceStats.set(span.service, stats);
  }

  console.log('Generation summary');
  console.log(`traces: ${traceCount}`);
  console.log(`spans: ${spans.length}`);
  console.log(`logs: ${logs.length}`);
  console.log(`error spans: ${errorSpanCount}`);
  console.log('\nPer-service average duration and error rate:');
  console.log('service | avg duration (ms) | error rate');

  for (const [service, stats] of [...serviceStats.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const averageDurationMs = Number(stats.durationNs) / stats.count / 1_000_000;
    const errorRatePercent = (stats.errorCount / stats.count) * 100;
    console.log(`${service} | ${averageDurationMs.toFixed(2)} | ${errorRatePercent.toFixed(2)}%`);
  }
}

function groupByTrace(spans, logs) {
  const traceIds = [];
  const spansByTrace = new Map();
  const logsByTrace = new Map();

  for (const span of spans) {
    if (!spansByTrace.has(span.trace_id)) {
      spansByTrace.set(span.trace_id, []);
      traceIds.push(span.trace_id);
    }
    spansByTrace.get(span.trace_id).push(span);
  }

  for (const log of logs) {
    if (!logsByTrace.has(log.trace_id)) {
      logsByTrace.set(log.trace_id, []);
      if (!spansByTrace.has(log.trace_id)) {
        traceIds.push(log.trace_id);
      }
    }
    logsByTrace.get(log.trace_id).push(log);
  }

  return { traceIds, spansByTrace, logsByTrace };
}

function makeRequestTasks({ spans, logs }, batchSize, baseUrl) {
  const { traceIds, spansByTrace, logsByTrace } = groupByTrace(spans, logs);
  const tasks = [];

  for (let offset = 0; offset < traceIds.length; offset += batchSize) {
    const traceBatch = traceIds.slice(offset, offset + batchSize);
    const spansBatch = traceBatch.flatMap((traceId) => spansByTrace.get(traceId) ?? []);
    const logsBatch = traceBatch.flatMap((traceId) => logsByTrace.get(traceId) ?? []);

    if (spansBatch.length > 0) {
      tasks.push({
        url: new URL('/v1/traces', baseUrl),
        body: JSON.stringify(toOtlpTraces(spansBatch)),
        type: 'traces',
        traceCount: traceBatch.filter((traceId) => (spansByTrace.get(traceId)?.length ?? 0) > 0).length,
        rowCount: spansBatch.length,
      });
    }
    if (logsBatch.length > 0) {
      tasks.push({
        url: new URL('/v1/logs', baseUrl),
        body: JSON.stringify(toOtlpLogs(logsBatch)),
        type: 'logs',
        traceCount: 0,
        rowCount: logsBatch.length,
      });
    }
  }

  return tasks;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function retryAfterMs(value, retryNumber) {
  if (value !== null && value.trim() !== '') {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return Math.min(250 * (2 ** (retryNumber - 1)), 8000);
}

async function postWithRetry(task) {
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      const response = await fetch(task.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: task.body,
      });
      const responseText = await response.text();
      if (response.ok) {
        return { ok: true };
      }

      const error = new Error(`HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`);
      if (response.status === 429 && attempt < retryLimit) {
        await delay(retryAfterMs(response.headers.get('retry-after'), attempt + 1));
        continue;
      }
      return { ok: false, error };
    } catch (error) {
      if (attempt >= retryLimit) {
        return { ok: false, error };
      }
      await delay(retryAfterMs(null, attempt + 1));
    }
  }

  return { ok: false, error: new Error('request retry limit reached') };
}

function elapsedSeconds(startedAt) {
  return Math.max((performance.now() - startedAt) / 1000, 0.001);
}

function printProgress(state, startedAt) {
  const elapsed = elapsedSeconds(startedAt);
  const spansPerSecond = state.sentSpans / elapsed;
  console.log(
    `Progress: sent traces ${state.sentTraces}, spans ${state.sentSpans}, `
    + `elapsed ${elapsed.toFixed(1)}s, spans/sec ${spansPerSecond.toFixed(2)}`,
  );
}

function startProgress(state, startedAt) {
  const timer = setInterval(() => printProgress(state, startedAt), 1000);
  timer.unref?.();
  return timer;
}

async function sendGenerated(generated, options, state) {
  const tasks = makeRequestTasks(generated, options.batch, options.baseUrl);
  let nextTask = 0;

  async function worker() {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask];
      nextTask += 1;
      const result = await postWithRetry(task);
      if (!result.ok) {
        state.failedRequests += 1;
        console.error(`Failed ${task.type} request after retries: ${result.error.message}`);
      } else if (task.type === 'traces') {
        state.sentTraces += task.traceCount;
        state.sentSpans += task.rowCount;
      } else {
        state.sentLogs += task.rowCount;
      }
    }
  }

  const workerCount = Math.min(options.concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function printSendSummary(state, startedAt) {
  const seconds = elapsedSeconds(startedAt);
  console.log('\nSend summary');
  console.log(`total traces: ${state.totalTraces}`);
  console.log(`total spans: ${state.totalSpans}`);
  console.log(`total logs: ${state.totalLogs}`);
  console.log(`failed requests: ${state.failedRequests}`);
  console.log(`total seconds: ${seconds.toFixed(2)}`);
  console.log(`spans/sec: ${(state.sentSpans / seconds).toFixed(2)}`);
}

function createSendState() {
  return {
    totalTraces: 0,
    totalSpans: 0,
    totalLogs: 0,
    sentTraces: 0,
    sentSpans: 0,
    sentLogs: 0,
    failedRequests: 0,
  };
}

function validateSendUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('--send must be an http or https URL');
  }
  return url;
}

async function runFiniteSend(traces, seed, faultService, faultStrength, spreadSeconds, options) {
  const state = createSendState();
  const startedAt = performance.now();
  const progressTimer = startProgress(state, startedAt);

  try {
    const generated = generate({ traces, seed, faultService, faultStrength, spreadSeconds });
    state.totalTraces = traces;
    state.totalSpans = generated.spans.length;
    state.totalLogs = generated.logs.length;
    await sendGenerated(generated, options, state);
  } finally {
    clearInterval(progressTimer);
  }

  printProgress(state, startedAt);
  printSendSummary(state, startedAt);
  if (state.failedRequests > 0) {
    process.exitCode = 1;
  }
}

async function runContinuousSend(seed, faultService, faultStrength, options) {
  const state = createSendState();
  const startedAt = performance.now();
  const progressTimer = startProgress(state, startedAt);
  let stopped = false;
  let resolveStop;
  const stopPromise = new Promise((resolveStopPromise) => {
    resolveStop = resolveStopPromise;
  });
  const stop = () => {
    stopped = true;
    resolveStop();
  };
  let second = 0;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    while (!stopped) {
      const tickStartedAt = performance.now();
      const generated = generate({
        traces: options.rate,
        seed: seed + second,
        faultService,
        faultStrength,
        endTimeNs: BigInt(Date.now()) * 1_000_000n,
        spreadSeconds: 1,
      });
      state.totalTraces += options.rate;
      state.totalSpans += generated.spans.length;
      state.totalLogs += generated.logs.length;
      await sendGenerated(generated, options, state);
      second += 1;

      const waitMs = Math.max(0, 1000 - (performance.now() - tickStartedAt));
      if (!stopped && waitMs > 0) {
        await Promise.race([delay(waitMs), stopPromise]);
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    clearInterval(progressTimer);
  }

  printProgress(state, startedAt);
  printSendSummary(state, startedAt);
  if (state.failedRequests > 0) {
    process.exitCode = 1;
  }
}

async function writeFiles(generated, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'traces.json'), stringifyJson(toOtlpTraces(generated.spans))),
    writeFile(resolve(outputDirectory, 'logs.json'), stringifyJson(toOtlpLogs(generated.logs))),
    writeFile(resolve(outputDirectory, 'flat.json'), stringifyJson(generated)),
  ]);
}

const tracesOption = Array.isArray(values.traces) ? values.traces.at(-1) : values.traces;
const traces = parseIntegerOption('traces', tracesOption);
const seed = parseIntegerOption('seed', values.seed);
const strength = parseNumberOption('strength', values.strength);
const spreadSeconds = parseNumberOption('spread', values.spread);
const batch = parseIntegerOption('batch', values.batch);
const concurrency = parseIntegerOption('concurrency', values.concurrency);
const rate = parseIntegerOption('rate', values.rate);
if (traces < 0 || strength < 0 || spreadSeconds < 0) {
  throw new RangeError('--traces, --strength, and --spread must not be negative');
}
if (batch <= 0 || concurrency <= 0 || rate <= 0) {
  throw new RangeError('--batch, --concurrency, and --rate must be positive integers');
}
if (values.continuous && !values.send) {
  throw new TypeError('--continuous requires --send');
}

if (values.send) {
  const options = {
    baseUrl: validateSendUrl(values.send),
    batch,
    concurrency,
    rate,
  };
  if (values.continuous) {
    await runContinuousSend(seed, values.fault ?? null, strength, options);
  } else {
    await runFiniteSend(traces, seed, values.fault ?? null, strength, spreadSeconds, options);
  }
} else {
  const generated = generate({
    traces,
    seed,
    faultService: values.fault ?? null,
    faultStrength: strength,
    spreadSeconds,
  });
  const outputDirectory = resolve(process.cwd(), values.out);
  await writeFiles(generated, outputDirectory);
  console.log(`Output directory: ${outputDirectory}`);
  summarize(generated.spans, generated.logs);
}
