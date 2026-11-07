# Ingestion throughput notes

Date: 2026-11-07

Machine: Apple M4, 10 logical CPU cores, 16 GiB RAM. Node.js v26.0.0.

## 5,000-trace local send

Started the ingestion server on its default port and sent through loopback with:

```sh
npm run gen:send -- --traces 5000 --seed 44
```

The generator used batch size 100 and concurrency 4. It produced 5,000 traces, 23,912 spans, and 24,755 logs. It reported 0 failed requests, 0.31 seconds total, and **77,351.42 spans/sec**.

After the server buffer drained, `GET /api/ingest/stats` reported 23,912 written spans, 0 queued rows, 0 failed flushes, 55 flushes, and **11,808.40 spans/sec**. The server metric is its process-lifetime rate; the process had been running for about 2.03 seconds when read, including startup. The generator rate uses the generator's own run interval, so the two rates use different timing windows.

The database had the original 18 seed spans and 10 seed logs plus two earlier 5,000-trace measurement runs. After this run, `GET /api/debug/counts` returned 71,838 spans and 74,212 logs.
