const STATUS_ATTRIBUTE_KEYS = new Set(['http.status_code', 'http.response.status_code']);

function decodeAttributeValue(attributeValue) {
  if (!attributeValue || typeof attributeValue !== 'object') {
    return undefined;
  }

  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (Object.hasOwn(attributeValue, key)) {
      return attributeValue[key];
    }
  }

  return undefined;
}

function attributesToObject(attributes) {
  const result = {};
  if (!Array.isArray(attributes)) {
    return result;
  }

  for (const attribute of attributes) {
    if (typeof attribute?.key !== 'string' || attribute.key.length === 0) {
      continue;
    }
    const value = decodeAttributeValue(attribute.value);
    if (value !== undefined) {
      result[attribute.key] = value;
    }
  }

  return result;
}

function serviceFor(resource) {
  const service = attributesToObject(resource?.attributes)['service.name'];
  return typeof service === 'string' && service.length > 0 ? service : 'unknown';
}

function timestampToBigInt(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) {
    throw new TypeError('timestamp number must be a finite integer');
  }
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw new TypeError('timestamp must be a string, number, or bigint');
  }
  return BigInt(value);
}

function integerStatusCode(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function parseOtlpTraces(payload) {
  const rows = [];
  let rejected = 0;
  const resourceSpans = Array.isArray(payload?.resourceSpans) ? payload.resourceSpans : [];

  for (const resourceSpan of resourceSpans) {
    const service = serviceFor(resourceSpan?.resource);
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];

      for (const span of spans) {
        try {
          if (
            typeof span?.traceId !== 'string' || span.traceId.length === 0
            || typeof span.spanId !== 'string' || span.spanId.length === 0
            || typeof span.name !== 'string' || span.name.length === 0
          ) {
            throw new TypeError('span is missing traceId, spanId, or name');
          }

          const startTs = timestampToBigInt(span.startTimeUnixNano);
          const endTs = timestampToBigInt(span.endTimeUnixNano);
          if (endTs < startTs) {
            throw new RangeError('span end timestamp is before its start timestamp');
          }

          const allAttributes = attributesToObject(span.attributes);
          const statusCode = integerStatusCode(
            allAttributes['http.status_code'] ?? allAttributes['http.response.status_code'],
          );
          const attributes = Object.fromEntries(
            Object.entries(allAttributes).filter(([key]) => !STATUS_ATTRIBUTE_KEYS.has(key)),
          );
          const parentSpanId = typeof span.parentSpanId === 'string' ? span.parentSpanId : '';

          rows.push({
            trace_id: span.traceId,
            span_id: span.spanId,
            parent_id: parentSpanId.length > 0 ? parentSpanId : null,
            service,
            name: span.name,
            start_ts: startTs,
            duration_ns: endTs - startTs,
            status_code: statusCode,
            is_error: Number(span.status?.code) === 2 || (statusCode !== null && statusCode >= 500),
            attributes,
          });
        } catch {
          rejected += 1;
        }
      }
    }
  }

  return { rows, rejected };
}
