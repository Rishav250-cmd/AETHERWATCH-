import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generate } from './generate.js';
import { toOtlpLogs, toOtlpTraces } from './otlp.js';

const { values } = parseArgs({
  options: {
    traces: { type: 'string', default: '100' },
    seed: { type: 'string', default: '42' },
    fault: { type: 'string' },
    strength: { type: 'string', default: '1' },
    spread: { type: 'string', default: '60' },
    out: { type: 'string', default: 'generator/out' },
  },
  allowPositionals: false,
  strict: true,
});

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

const traces = parseIntegerOption('traces', values.traces);
const seed = parseIntegerOption('seed', values.seed);
const strength = parseNumberOption('strength', values.strength);
const spreadSeconds = parseNumberOption('spread', values.spread);
if (traces < 0 || strength < 0 || spreadSeconds < 0) {
  throw new RangeError('--traces, --strength, and --spread must not be negative');
}

const { spans, logs } = generate({
  traces,
  seed,
  faultService: values.fault ?? null,
  faultStrength: strength,
  spreadSeconds,
});

const outputDirectory = resolve(process.cwd(), values.out);
await mkdir(outputDirectory, { recursive: true });

const tracePayload = toOtlpTraces(spans);
const logPayload = toOtlpLogs(logs);
const flatPayload = { spans, logs };

await Promise.all([
  writeFile(resolve(outputDirectory, 'traces.json'), stringifyJson(tracePayload)),
  writeFile(resolve(outputDirectory, 'logs.json'), stringifyJson(logPayload)),
  writeFile(resolve(outputDirectory, 'flat.json'), stringifyJson(flatPayload)),
]);

console.log(`Output directory: ${outputDirectory}`);
summarize(spans, logs);
