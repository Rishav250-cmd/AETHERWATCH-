import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, '../..');
const databasePath = resolve(projectRoot, 'data', 'aetherwatch.duckdb');

await rm(databasePath, { force: true });
await rm(`${databasePath}.wal`, { force: true });

for (const scriptName of ['init-db.js', 'seed.js']) {
  const scriptPath = resolve(scriptsDirectory, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
