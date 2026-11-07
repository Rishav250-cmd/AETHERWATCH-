const TABLES = new Set(['spans', 'logs']);

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export class BatchBuffer {
  constructor({
    maxItems = 1000,
    flushIntervalMs = 1000,
    maxQueued = 200000,
    onFlush,
  } = {}) {
    positiveInteger('maxItems', maxItems);
    positiveInteger('flushIntervalMs', flushIntervalMs);
    positiveInteger('maxQueued', maxQueued);
    if (typeof onFlush !== 'function') {
      throw new TypeError('onFlush must be a function');
    }

    this.maxItems = maxItems;
    this.maxQueued = maxQueued;
    this.onFlush = onFlush;
    this.queues = { spans: [], logs: [] };
    this.inFlight = 0;
    this.flushPromise = null;
    this.flushAgain = false;
    this.closed = false;
    this.counters = {
      received: 0,
      written: 0,
      flushes: 0,
      failedFlushes: 0,
      lastFlushMs: 0,
      droppedRows: 0,
    };

    this.timer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
    this.timer.unref?.();
  }

  add(table, rows) {
    if (!TABLES.has(table)) {
      throw new TypeError(`table must be "spans" or "logs"`);
    }
    if (!Array.isArray(rows)) {
      throw new TypeError('rows must be an array');
    }
    if (this.closed) {
      return false;
    }
    if (this.queuedCount() + rows.length > this.maxQueued) {
      return false;
    }

    for (const row of rows) {
      this.queues[table].push(row);
    }
    this.counters.received += rows.length;

    if (this.queues[table].length >= this.maxItems) {
      void this.flush();
    }
    return true;
  }

  queuedCount() {
    return this.inFlight + this.queues.spans.length + this.queues.logs.length;
  }

  stats() {
    return {
      ...this.counters,
      queued: this.queuedCount(),
    };
  }

  flush() {
    if (this.flushPromise) {
      this.flushAgain = true;
      return this.flushPromise;
    }

    const drainPromise = Promise.resolve().then(() => this.drainQueues());
    this.flushPromise = drainPromise.finally(() => {
      this.flushPromise = null;
      if (this.flushAgain || this.queues.spans.length > 0 || this.queues.logs.length > 0) {
        this.flushAgain = false;
        void this.flush();
      }
    });
    return this.flushPromise;
  }

  async drainQueues() {
    while (this.queues.spans.length > 0 || this.queues.logs.length > 0) {
      const spansBatch = this.queues.spans.splice(0, this.maxItems);
      const logsBatch = this.queues.logs.splice(0, this.maxItems);
      const batchSize = spansBatch.length + logsBatch.length;
      this.inFlight += batchSize;
      const startedAt = Date.now();
      let succeeded = false;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.onFlush(spansBatch, logsBatch);
          succeeded = true;
          this.counters.flushes += 1;
          this.counters.written += batchSize;
          break;
        } catch (error) {
          this.counters.failedFlushes += 1;
          console.error(`BatchBuffer flush failed${attempt === 0 ? '; retrying once' : '; dropping batch'}`, error);
        }
      }

      if (!succeeded) {
        this.counters.droppedRows += batchSize;
      }
      this.counters.lastFlushMs = Date.now() - startedAt;
      this.inFlight -= batchSize;
    }
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      clearInterval(this.timer);
    }
    await this.flush();
  }
}
