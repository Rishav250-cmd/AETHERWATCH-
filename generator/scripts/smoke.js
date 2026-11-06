import { generate } from '../src/generate.js';

const result = generate({
  traces: 5,
  seed: 42,
  endTimeNs: 1_800_000_000_000_000_000n,
  spreadSeconds: 60,
});

const firstTraceId = result.spans[0]?.trace_id;
const firstTraceSpans = result.spans.filter((span) => span.trace_id === firstTraceId);
const spansByParent = new Map();

for (const span of firstTraceSpans) {
  const siblings = spansByParent.get(span.parent_id) ?? [];
  siblings.push(span);
  spansByParent.set(span.parent_id, siblings);
}

const firstTraceSpanById = new Map(firstTraceSpans.map((span) => [span.span_id, span]));
for (const span of firstTraceSpans) {
  if (span.parent_id === null) {
    continue;
  }

  const parent = firstTraceSpanById.get(span.parent_id);
  const childEnd = span.start_ts + span.duration_ns;
  const parentEnd = parent.start_ts + parent.duration_ns;
  if (span.start_ts < parent.start_ts || childEnd > parentEnd) {
    throw new Error(`Span ${span.span_id} falls outside parent ${parent.span_id}`);
  }
}

function printTree(parentId, depth) {
  for (const span of spansByParent.get(parentId) ?? []) {
    const durationMs = (Number(span.duration_ns) / 1_000_000).toFixed(2);
    console.log(`${'  '.repeat(depth)}${span.service} | ${span.name} | ${durationMs} ms | ${span.status_code}`);
    printTree(span.span_id, depth + 1);
  }
}

console.log('First trace:');
printTree(null, 0);
console.log(`Counts: ${result.spans.length} spans, ${result.logs.length} logs`);
