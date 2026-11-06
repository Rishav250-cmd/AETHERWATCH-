const scopeName = 'aetherwatch-generator';

function int64String(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value).toString();
  }
  return String(value);
}

function attributeString(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, nestedValue) => (
      typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
    ));
  }
  return String(value);
}

function stringAttributes(attributes = {}) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: attributeString(value) },
  }));
}

function resourceFor(service) {
  return {
    attributes: [
      { key: 'service.name', value: { stringValue: service } },
    ],
  };
}

function groupByService(records) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.service) ?? [];
    group.push(record);
    groups.set(record.service, group);
  }
  return groups;
}

export function toOtlpTraces(spans) {
  const resourceSpans = [];

  for (const [service, serviceSpans] of groupByService(spans)) {
    resourceSpans.push({
      resource: resourceFor(service),
      scopeSpans: [
        {
          scope: { name: scopeName },
          spans: serviceSpans.map((span) => {
            const attributes = [
              {
                key: 'http.status_code',
                value: { intValue: int64String(span.status_code) },
              },
              ...stringAttributes(span.attributes),
            ];
            const errorMessage = span.attributes?.['error.message'];

            return {
              traceId: span.trace_id,
              spanId: span.span_id,
              parentSpanId: span.parent_id ?? '',
              name: span.name,
              kind: 2,
              startTimeUnixNano: int64String(span.start_ts),
              endTimeUnixNano: int64String(BigInt(span.start_ts) + BigInt(span.duration_ns)),
              attributes,
              status: {
                code: span.is_error ? 2 : 1,
                message: span.is_error
                  ? attributeString(errorMessage ?? `span failed with status ${span.status_code}`)
                  : '',
              },
            };
          }),
        },
      ],
    });
  }

  return { resourceSpans };
}

export function toOtlpLogs(logs) {
  const resourceLogs = [];

  for (const [service, serviceLogs] of groupByService(logs)) {
    resourceLogs.push({
      resource: resourceFor(service),
      scopeLogs: [
        {
          scope: { name: scopeName },
          logRecords: serviceLogs.map((log) => ({
            timeUnixNano: int64String(log.ts),
            severityText: String(log.level).toUpperCase(),
            body: { stringValue: String(log.message) },
            attributes: stringAttributes(log.attributes),
            traceId: log.trace_id,
            spanId: log.span_id,
          })),
        },
      ],
    });
  }

  return { resourceLogs };
}
