import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultDatabasePath = resolve(projectRoot, 'data', 'aetherwatch.duckdb');
let databasePath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : defaultDatabasePath;

let databasePromise;

async function openDatabase() {
  await mkdir(dirname(databasePath), { recursive: true });
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  return { instance, connection };
}

function getDatabase() {
  databasePromise ??= openDatabase();
  return databasePromise;
}

export function setDatabasePath(path) {
  if (databasePromise) {
    throw new Error('Cannot change the database path after opening the database');
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('database path must be a non-empty string');
  }
  databasePath = resolve(path);
}

export async function getConnection() {
  const database = await getDatabase();
  return database.connection;
}

function normalizeValue(value) {
  if (typeof value === 'bigint') {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]),
    );
  }

  return value;
}

export async function run(sql, params) {
  const { connection } = await getDatabase();
  return params === undefined
    ? connection.run(sql)
    : connection.run(sql, params);
}

export async function all(sql, params) {
  const { connection } = await getDatabase();
  const reader = params === undefined
    ? await connection.runAndReadAll(sql)
    : await connection.runAndReadAll(sql, params);

  try {
    return reader.getRowObjectsJS().map(normalizeValue);
  } finally {
    reader.closeSync();
  }
}

export async function close() {
  if (!databasePromise) {
    return;
  }

  const database = await databasePromise;
  database.connection.closeSync();
  database.instance.closeSync();
  databasePromise = undefined;
}
