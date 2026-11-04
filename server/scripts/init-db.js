import { readFile } from 'node:fs/promises';
import { close, run } from '../src/db.js';

const schemaUrl = new URL('../src/schema.sql', import.meta.url);

try {
  const schema = await readFile(schemaUrl, 'utf8');
  const statements = schema
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await run(statement);
  }

  console.log('Tables created: spans, logs');
} finally {
  await close();
}
