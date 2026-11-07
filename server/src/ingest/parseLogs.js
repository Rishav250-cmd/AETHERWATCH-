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

function logTimestamp(logRecord) {
  try {
    return timestampToBigInt(logRecord.timeUnixNano);
  } catch {
    return timestampToBigInt(logRecord.observedTimeUnixNano);
  }
}

function normalizedLevel(severityText, severityNumber) {
  const level = typeof severityText === 'string' ? severityText.trim().toUpperCase() : '';
  if (['INFO', 'WARN', 'ERROR'].includes(level)) {
    return level;
  }
  if (level === 'WARNING') {
    return 'WARN';
  }
  if (['DEBUG', 'TRACE'].includes(level)) {
    return 'INFO';
  }
  if (['FATAL', 'CRITICAL', 'ALERT', 'EMERGENCY'].includes(level)) {
    return 'ERROR';
  }

  const number = Number(severityNumber);
  if (Number.isFinite(number) && number >= 17) {
    return 'ERROR';
  }
  if (Number.isFinite(number) && number >= 13) {
    return 'WARN';
  }
  return 'INFO';
}

function stringifyBody(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? '', (_key, nestedValue) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  )) ?? '';
}

export function parseOtlpLogs(payload) {
  const rows = [];
  let rejected = 0;
  const resourceLogs = Array.isArray(payload?.resourceLogs) ? payload.resourceLogs : [];

  for (const resourceLog of resourceLogs) {
    const service = serviceFor(resourceLog?.resource);
    const scopeLogs = Array.isArray(resourceLog?.scopeLogs) ? resourceLog.scopeLogs : [];

    for (const scopeLog of scopeLogs) {
      const logRecords = Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : [];

      for (const logRecord of logRecords) {
        try {
          const ts = logTimestamp(logRecord);
          const attributes = attributesToObject(logRecord.attributes);
          if (typeof logRecord.spanId === 'string' && logRecord.spanId.length > 0) {
            attributes.span_id = logRecord.spanId;
          }

          const body = logRecord.body;
          const message = body && typeof body === 'object' && Object.hasOwn(body, 'stringValue')
            ? stringifyBody(body.stringValue)
            : stringifyBody(body);

          rows.push({
            ts,
            service,
            level: normalizedLevel(logRecord.severityText, logRecord.severityNumber),
            message,
            trace_id: typeof logRecord.traceId === 'string' && logRecord.traceId.length > 0
              ? logRecord.traceId
              : null,
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
