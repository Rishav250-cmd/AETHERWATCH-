import { all, getConnection } from '../db.js';

function jsonString(value) {
  return JSON.stringify(value ?? {}, (_key, nestedValue) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  ));
}

function appendNullableVarchar(appender, value) {
  if (value === null || value === undefined || value === '') {
    appender.appendNull();
  } else {
    appender.appendVarchar(String(value));
  }
}

async function appendRows(table, rows, appendRow) {
  const connection = await getConnection();
  const appender = await connection.createAppender(table);
  try {
    for (const row of rows) {
      appendRow(appender, row);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
    return rows.length;
  } catch (error) {
    try {
      appender.closeSync();
    } catch {
      // Closing a failed Appender can repeat its original constraint error.
    }
    throw error;
  }
}

function deduplicateSpans(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.trace_id}\u0000${row.span_id}`;
    if (!unique.has(key)) {
      unique.set(key, row);
    }
  }
  return [...unique.values()];
}

function isConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(constraint|duplicate key|unique violation)/i.test(message);
}

async function insertSpansIgnoringDuplicates(rows) {
  let written = 0;
  const columns = [
    'trace_id', 'span_id', 'parent_id', 'service', 'name',
    'start_ts', 'duration_ns', 'status_code', 'is_error', 'attributes',
  ];

  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    const valueGroup = `(${columns.map(() => '?').join(', ')})`;
    const valuesSql = chunk.map(() => valueGroup).join(', ');
    const params = [];

    for (const row of chunk) {
      params.push(
        row.trace_id,
        row.span_id,
        row.parent_id,
        row.service,
        row.name,
        BigInt(row.start_ts),
        BigInt(row.duration_ns),
        row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
        Boolean(row.is_error),
        jsonString(row.attributes),
      );
    }

    const inserted = await all(
      `INSERT OR IGNORE INTO spans (${columns.join(', ')}) VALUES ${valuesSql} RETURNING span_id`,
      params,
    );
    written += inserted.length;
  }

  return written;
}

export async function writeSpans(rows) {
  const uniqueRows = deduplicateSpans(rows);
  if (uniqueRows.length === 0) {
    return 0;
  }

  try {
    return await appendRows('spans', uniqueRows, (appender, row) => {
      appender.appendVarchar(String(row.trace_id));
      appender.appendVarchar(String(row.span_id));
      appendNullableVarchar(appender, row.parent_id);
      appender.appendVarchar(String(row.service));
      appender.appendVarchar(String(row.name));
      appender.appendBigInt(BigInt(row.start_ts));
      appender.appendBigInt(BigInt(row.duration_ns));
      if (row.status_code === null || row.status_code === undefined) {
        appender.appendNull();
      } else {
        appender.appendInteger(Number(row.status_code));
      }
      appender.appendBoolean(Boolean(row.is_error));
      appender.appendVarchar(jsonString(row.attributes));
    });
  } catch (error) {
    if (!isConstraintError(error)) {
      throw error;
    }
    return insertSpansIgnoringDuplicates(uniqueRows);
  }
}

export async function writeLogs(rows) {
  if (rows.length === 0) {
    return 0;
  }

  return appendRows('logs', rows, (appender, row) => {
    appender.appendBigInt(BigInt(row.ts));
    appender.appendVarchar(String(row.service));
    appender.appendVarchar(String(row.level));
    appender.appendVarchar(String(row.message));
    appendNullableVarchar(appender, row.trace_id);
    appender.appendVarchar(jsonString(row.attributes));
  });
}
