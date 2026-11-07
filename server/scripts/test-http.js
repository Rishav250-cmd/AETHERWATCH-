import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { generate } from '../../generator/src/generate.js';
import { toOtlpLogs, toOtlpTraces } from '../../generator/src/otlp.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];

function fail(message) {
  throw new Error(message);
}

async function check(label, action) {
  try {
    await action();
    console.log(`PASS ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ label, message });
    console.log(`FAIL ${label}: ${message}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

function initializeDatabase(databasePath) {
  const result = spawnSync(process.execPath, ['server/scripts/init-db.js'], {
    cwd: projectRoot,
    env: { ...process.env, DB_PATH: databasePath },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`temporary database initialization failed: ${result.stderr || result.stdout}`);
  }
}

function startServer(port, databasePath) {
  const child = spawn(process.execPath, ['server/src/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DB_PATH: databasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { child, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { handle.stdout += chunk; });
  child.stderr.on('data', (chunk) => { handle.stderr += chunk; });
  handle.exit = new Promise((resolveExit) => {
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  return handle;
}

async function waitForHealth(handle, baseUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`server exited early: ${handle.stderr}\n${handle.stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Retry briefly while Fastify opens the database and binds its port.
    }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${handle.stderr}\n${handle.stdout}`);
}

async function stopServer(handle, signal = 'SIGINT') {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return handle.exit;
  }

  handle.child.kill(signal);
  let timeout;
  const timedOut = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(null), 10000);
  });
  let result = await Promise.race([handle.exit, timedOut]);
  clearTimeout(timeout);
  if (result === null) {
    handle.child.kill('SIGKILL');
    result = await handle.exit;
  }
  return result;
}

async function getCounts(baseUrl) {
  const response = await fetch(`${baseUrl}/api/debug/counts`);
  if (!response.ok) {
    throw new Error(`counts endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(baseUrl, route, payload) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'aetherwatch-http-'));
  const databasePath = join(temporaryDirectory, 'ingest-http-test.duckdb');
  let server;

  try {
    initializeDatabase(databasePath);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(port, databasePath);
    const health = await waitForHealth(server, baseUrl);
    let expectedSpans = 0;
    let expectedLogs = 0;

    const initial = generate({
      traces: 8,
      seed: 1001,
      endTimeNs: 1_800_000_000_000_000_000n,
    });
    const initialTracePayload = toOtlpTraces(initial.spans);
    const initialLogPayload = toOtlpLogs(initial.logs);

    await check('a) health endpoint returns ok', () => {
      if (health.status !== 'ok' || typeof health.uptimeSec !== 'number') {
        fail(`unexpected health response: ${JSON.stringify(health)}`);
      }
    });

    await check('b) OTLP traces are accepted and written', async () => {
      const response = await postJson(baseUrl, '/v1/traces', initialTracePayload);
      if (response.status !== 200) {
        fail(`trace request returned HTTP ${response.status}: ${await response.text()}`);
      }
      expectedSpans += initial.spans.length;
      await delay(2100);
      const counts = await getCounts(baseUrl);
      if (counts.spans !== expectedSpans) {
        fail(`database has ${counts.spans} spans; expected ${expectedSpans}`);
      }
    });

    await check('c) OTLP logs are accepted and written', async () => {
      const response = await postJson(baseUrl, '/v1/logs', initialLogPayload);
      if (response.status !== 200) {
        fail(`log request returned HTTP ${response.status}: ${await response.text()}`);
      }
      expectedLogs += initial.logs.length;
      await delay(2100);
      const counts = await getCounts(baseUrl);
      if (counts.logs !== expectedLogs) {
        fail(`database has ${counts.logs} logs; expected ${expectedLogs}`);
      }
    });

    const gzipData = generate({
      traces: 3,
      seed: 1002,
      endTimeNs: 1_800_000_000_000_000_000n,
    });
    await check('d) gzip-compressed OTLP JSON is accepted', async () => {
      const response = await fetch(`${baseUrl}/v1/traces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: gzipSync(JSON.stringify(toOtlpTraces(gzipData.spans))),
      });
      if (response.status !== 200) {
        fail(`gzip trace request returned HTTP ${response.status}: ${await response.text()}`);
      }
      expectedSpans += gzipData.spans.length;
      await delay(2100);
      const counts = await getCounts(baseUrl);
      if (counts.spans !== expectedSpans) {
        fail(`database has ${counts.spans} spans after gzip; expected ${expectedSpans}`);
      }
    });

    await check('e) protobuf content type returns 415', async () => {
      const response = await fetch(`${baseUrl}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: Buffer.from([0, 1, 2, 3]),
      });
      const body = await response.json();
      if (response.status !== 415 || !String(body.error).includes('OTLP/HTTP JSON')) {
        fail(`expected clear HTTP 415 response; got ${response.status} ${JSON.stringify(body)}`);
      }
    });

    await check('f) invalid JSON returns 400', async () => {
      const response = await fetch(`${baseUrl}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ invalid json',
      });
      if (response.status !== 400) {
        fail(`invalid JSON returned HTTP ${response.status}`);
      }
    });

    await check('g) duplicate traces do not increase the span count', async () => {
      const response = await postJson(baseUrl, '/v1/traces', initialTracePayload);
      if (response.status !== 200) {
        fail(`duplicate trace request returned HTTP ${response.status}`);
      }
      await delay(1600);
      const counts = await getCounts(baseUrl);
      if (counts.spans !== expectedSpans) {
        fail(`duplicate request changed span count to ${counts.spans}; expected ${expectedSpans}`);
      }
    });

    await check('h) SIGINT flushes pending rows and data survives a restart', async () => {
      const before = await getCounts(baseUrl);
      let pendingSpanCount = 0;
      let observedQueuedRows = false;
      let attempt = 0;

      while (!observedQueuedRows && attempt < 8) {
        const pending = generate({
          traces: 1,
          seed: 2000 + attempt,
          endTimeNs: BigInt(Date.now()) * 1_000_000n,
          spreadSeconds: 0,
        });
        const response = await postJson(baseUrl, '/v1/traces', toOtlpTraces(pending.spans));
        if (response.status !== 200) {
          fail(`shutdown test request returned HTTP ${response.status}`);
        }
        pendingSpanCount += pending.spans.length;
        const statsResponse = await fetch(`${baseUrl}/api/ingest/stats`);
        const stats = await statsResponse.json();
        observedQueuedRows = stats.queued >= pending.spans.length;
        attempt += 1;
        if (!observedQueuedRows) {
          await delay(50);
        }
      }

      if (!observedQueuedRows) {
        fail('could not observe a pending span batch before shutdown');
      }

      const stopped = await stopServer(server, 'SIGINT');
      const shutdownOutput = `${server.stdout}\n${server.stderr}`;
      server = undefined;
      if (stopped.code !== 0) {
        fail(`server exited with code ${stopped.code}: ${shutdownOutput}`);
      }
      if (!/Flushed [1-9]\d* rows during shutdown/.test(shutdownOutput)) {
        fail(`shutdown did not report flushing rows: ${shutdownOutput}`);
      }

      server = startServer(port, databasePath);
      await waitForHealth(server, baseUrl);
      const afterRestart = await getCounts(baseUrl);
      if (afterRestart.spans !== before.spans + pendingSpanCount) {
        fail(`restart has ${afterRestart.spans} spans; expected ${before.spans + pendingSpanCount}`);
      }
    });

    if (server) {
      await stopServer(server, 'SIGINT');
      server = undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ label: 'test setup', message });
    console.log(`FAIL test setup: ${message}`);
  } finally {
    if (server) {
      await stopServer(server, 'SIGTERM');
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} HTTP ingestion check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll HTTP ingestion checks passed.');
  }
}

await main();
