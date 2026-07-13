import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Job,
  JobCommand,
  JobError,
  JobEvent,
  JobEventName,
  JobFileObservability,
  JobMetrics,
  JobMetricsSummary,
  JobTokenMetrics,
  JobResult,
  JobStatus,
  PublicJob,
  RunningProcess,
  StoredJob,
} from "./types.js";

export type JobStoreOptions = {
  jobsDir: string;
  heartbeatMs: number;
  retention?: Partial<JobRetentionPolicy>;
  startRunner: (
    job: Job,
    hooks: { onAgentEvent: (event: unknown) => void },
  ) => RunningProcess;
};

type JobEventListener = (event: JobEvent) => void;

type JobRetentionPolicy = {
  succeededEventLogDays: number;
  succeededEventLogCount: number;
  otherEventLogDays: number;
  otherEventLogCount: number;
  metaDays: number;
};

const DEFAULT_RETENTION: JobRetentionPolicy = {
  succeededEventLogDays: 30,
  succeededEventLogCount: 50,
  otherEventLogDays: 90,
  otherEventLogCount: 100,
  metaDays: 180,
};

const RAW_EVENT_LOGS_DIR_NAME = "raw-events";
const MAX_OBSERVABILITY_DEPTH = 8;
const MAX_OBSERVABILITY_NODES = 500;
const MAX_OBSERVABILITY_ARRAY_ITEMS = 50;
const MAX_OBSERVABILITY_STRING_LENGTH = 4096;
const MAX_PATCH_HEADER_SCAN_CHARS = 256 * 1024;
const MAX_PATCH_HEADER_SCAN_LINES = 5000;
const MAX_PATCH_HEADER_LINE_LENGTH = 2048;

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly events = new Map<string, JobEvent[]>();
  private readonly queue: string[] = [];
  private readonly emitter = new EventEmitter();
  private readonly retention: JobRetentionPolicy;
  private activeJobId: string | undefined;
  private activeProcess: RunningProcess | undefined;
  private nextSeq = 1;
  private persistQueue: Promise<void> = Promise.resolve();
  private heartbeatTimer: NodeJS.Timeout;
  private pruneTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: JobStoreOptions) {
    this.retention = { ...DEFAULT_RETENTION, ...options.retention };
    mkdirSync(options.jobsDir, { recursive: true });
    mkdirSync(this.rawEventLogsDir(), { recursive: true });
    this.migrateLegacyEventLogs();
    this.prunePersistedJobs();
    this.loadPersistedJobs();

    this.heartbeatTimer = setInterval(() => {
      this.emitHeartbeat();
    }, options.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  enqueue(command: JobCommand, content: string): PublicJob {
    const now = new Date().toISOString();
    const queuedAheadCount = this.queue.length + (this.activeJobId ? 1 : 0);
    const job: Job = {
      id: randomUUID(),
      command,
      content,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      contentLength: content.length,
      contentPreview: makeContentPreview(content),
      lastEventAt: now,
      metrics: {
        queuedAheadCount,
      },
    };

    this.jobs.set(job.id, job);
    this.events.set(job.id, []);
    this.queue.push(job.id);
    this.persistJob(job);
    this.recordEvent(job.id, "status", this.publicJob(job));
    this.processQueue();

    return this.publicJob(job);
  }

  getJob(jobId: string): PublicJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.publicJob(job) : undefined;
  }

  getEvents(jobId: string): JobEvent[] {
    const inMemoryEvents = this.events.get(jobId);
    if (inMemoryEvents) {
      return inMemoryEvents.map(normalizeJobEvent);
    }

    return this.loadJobEvents(jobId);
  }

  getMetricsSummary(): JobMetricsSummary {
    const counts: JobMetricsSummary["counts"] = {
      total: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      terminal: 0,
    };
    const averages = {
      queueWaitMs: makeAverageAccumulator(),
      runMs: makeAverageAccumulator(),
      totalMs: makeAverageAccumulator(),
    };

    for (const job of this.jobs.values()) {
      counts.total += 1;
      counts[job.status] += 1;
      if (!isTerminalStatus(job.status)) continue;

      counts.terminal += 1;
      const metrics = ensureJobMetrics(job);
      addAverageValue(averages.queueWaitMs, metrics.queueWaitMs);
      addAverageValue(averages.runMs, metrics.runMs);
      addAverageValue(averages.totalMs, metrics.totalMs);
    }

    const runningJob = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    return {
      counts,
      averages: {
        queueWaitMs: finishAverage(averages.queueWaitMs),
        runMs: finishAverage(averages.runMs),
        totalMs: finishAverage(averages.totalMs),
        samples: {
          queueWaitMs: averages.queueWaitMs.count,
          runMs: averages.runMs.count,
          totalMs: averages.totalMs.count,
        },
      },
      current: {
        queued: this.queue
          .map((jobId) => this.jobs.get(jobId))
          .filter((job): job is Job => Boolean(job))
          .map((job, index) => ({
            id: job.id,
            command: job.command,
            createdAt: job.createdAt,
            queuedAheadCount: (this.activeJobId ? 1 : 0) + index,
          })),
        running: runningJob
          ? {
              id: runningJob.id,
              command: runningJob.command,
              startedAt: runningJob.startedAt,
              queueWaitMs: ensureJobMetrics(runningJob).queueWaitMs,
              runMs: runningJob.startedAt ? Date.now() - Date.parse(runningJob.startedAt) : undefined,
            }
          : null,
      },
    };
  }

  onJobEvent(jobId: string, listener: JobEventListener): () => void {
    const eventName = this.eventName(jobId);
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  cancel(jobId: string): PublicJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    if (isTerminalStatus(job.status)) {
      return this.publicJob(job);
    }

    if (job.status === "queued") {
      const queueIndex = this.queue.indexOf(jobId);
      if (queueIndex !== -1) {
        this.queue.splice(queueIndex, 1);
      }
      this.finishJob(job, "cancelled", { message: "queued job cancelled" });
      return this.publicJob(job);
    }

    if (job.status === "running") {
      this.finishJob(job, "cancelled", { message: "running job cancelled" });
      this.activeProcess?.cancel();
      return this.publicJob(job);
    }

    return this.publicJob(job);
  }

  private processQueue() {
    if (this.activeJobId) return;

    const nextJobId = this.queue.shift();
    if (!nextJobId) return;

    const job = this.jobs.get(nextJobId);
    if (!job || job.status !== "queued") {
      this.processQueue();
      return;
    }

    this.activeJobId = job.id;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.lastEventAt = job.startedAt;
    updateStartedMetrics(job);
    this.persistJob(job);
    this.recordEvent(job.id, "status", this.publicJob(job));

    let running: RunningProcess;
    try {
      running = this.options.startRunner(job, {
        onAgentEvent: (event) => {
          const current = this.jobs.get(job.id);
          if (!current || current.status !== "running") return;
          current.lastEventAt = new Date().toISOString();
          current.updatedAt = current.lastEventAt;
          applyAgentObservability(current, event);
          this.persistJob(current);
          this.recordEvent(job.id, "agent_event", event);
        },
      });
    } catch (error) {
      this.finishJob(job, "failed", {
        message: `failed to start runner: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      this.clearActive(job.id);
      this.processQueue();
      return;
    }

    this.activeProcess = running;
    void running.done.then((result) => {
      const current = this.jobs.get(job.id);
      if (!current) return;

      if (current.status === "cancelled") {
        this.clearActive(job.id);
        this.processQueue();
        return;
      }

      if (result.ok) {
        this.finishJob(current, "succeeded", undefined, result.result);
      } else {
        this.finishJob(current, "failed", result.error);
      }

      this.clearActive(job.id);
      this.processQueue();
    });
  }

  private finishJob(
    job: Job,
    status: Extract<JobStatus, "succeeded" | "failed" | "cancelled" | "interrupted">,
    error?: JobError,
    result?: JobResult,
  ) {
    const now = new Date().toISOString();
    job.status = status;
    job.updatedAt = now;
    job.finishedAt = now;
    job.lastEventAt = now;
    updateFinishedMetrics(job);
    if (error) {
      job.error = error;
    }
    if (result) {
      job.result = result;
    }

    this.persistJob(job);
    this.recordEvent(job.id, "status", this.publicJob(job));
    this.recordEvent(job.id, "done", this.publicJob(job));
    this.schedulePrune();
  }

  private clearActive(jobId: string) {
    if (this.activeJobId === jobId) {
      this.activeJobId = undefined;
      this.activeProcess = undefined;
    }
  }

  private emitHeartbeat() {
    if (!this.activeJobId) return;
    const job = this.jobs.get(this.activeJobId);
    if (!job || job.status !== "running") return;

    this.recordEvent(
      job.id,
      "heartbeat",
      {
        jobId: job.id,
        status: job.status,
        elapsedMs: job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0,
        lastEventAt: job.lastEventAt,
      },
      { persist: false },
    );
  }

  private recordEvent(
    jobId: string,
    event: JobEventName,
    data: unknown,
    options: { persist?: boolean } = {},
  ) {
    const envelope: JobEvent = {
      seq: this.nextSeq++,
      at: new Date().toISOString(),
      jobId,
      event,
      data,
    };

    const jobEvents = this.events.get(jobId) ?? [];
    jobEvents.push(envelope);
    this.events.set(jobId, jobEvents);
    this.emitter.emit(this.eventName(jobId), envelope);

    if (options.persist !== false) {
      this.persistEvent(envelope);
    }
  }

  private persistJob(job: Job) {
    const stored = this.storedJob(job);
    const metaPath = this.jobMetaPath(job.id);
    const content = `${JSON.stringify(stored, null, 2)}\n`;
    this.enqueuePersist(() => writeFile(metaPath, content, "utf8"));
  }

  private persistEvent(event: JobEvent) {
    const logPath = this.jobLogPath(event.jobId);
    const line = `${JSON.stringify(event)}\n`;
    this.enqueuePersist(() => appendFile(logPath, line, "utf8"));
  }

  private enqueuePersist(operation: () => Promise<void>) {
    const run = this.persistQueue.then(operation, operation);
    this.persistQueue = run.catch(() => undefined);
    void run.catch((error) => {
      console.error("[wiki-server] failed to persist job store", error);
    });
  }

  private loadPersistedJobs() {
    const files = existsSync(this.options.jobsDir) ? readdirSync(this.options.jobsDir) : [];
    this.advanceNextSeqFromPersistedEvents();
    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;
      const fullPath = path.join(this.options.jobsDir, file);
      try {
        const stored = JSON.parse(readFileSyncUtf8(fullPath)) as StoredJob;
        const hasLegacyReferencedFilePaths = hasLegacyReferencedFilePathsMetric(stored.metrics);
        const job: Job = {
          ...stored,
          content: "",
          metrics: normalizeJobMetrics(stored),
        };
        this.jobs.set(job.id, job);
        if (hasLegacyReferencedFilePaths) {
          tryBackfillStoredJob(fullPath, this.storedJob(job));
        }
        if (job.status === "running" || job.status === "queued") {
          this.events.set(job.id, this.loadJobEvents(job.id));
          this.markInterruptedOnStartup(job);
        }
      } catch {
        continue;
      }
    }
  }

  private advanceNextSeqFromPersistedEvents() {
    const logFiles = this.listEventLogFiles();
    for (const { jobId } of logFiles) {
      for (const event of this.loadJobEvents(jobId)) {
        this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
      }
    }
  }

  private markInterruptedOnStartup(job: Job) {
    const previousStatus = job.status;
    const now = new Date().toISOString();
    job.status = "interrupted";
    job.updatedAt = now;
    job.finishedAt = now;
    job.lastEventAt = now;
    updateFinishedMetrics(job);
    job.error = {
      message:
        previousStatus === "queued"
          ? "server restarted before queued job ran"
          : "server restarted before job completed",
    };
    this.persistJob(job);
    this.recordEvent(job.id, "status", this.publicJob(job));
    this.recordEvent(job.id, "done", this.publicJob(job));
  }

  private loadJobEvents(jobId: string): JobEvent[] {
    const logPath = this.resolveJobLogPath(jobId);
    if (!existsSync(logPath)) return [];
    const lines = readFileSyncUtf8(logPath)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const events: JobEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as JobEvent;
        events.push(normalizeJobEvent(event));
        this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
      } catch {
        continue;
      }
    }
    return events;
  }

  private schedulePrune() {
    if (this.pruneTimer) return;

    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      this.prunePersistedJobs();
    }, 5000);
    this.pruneTimer.unref();
  }

  private prunePersistedJobs() {
    if (!existsSync(this.options.jobsDir)) return;

    const files = readdirSync(this.options.jobsDir);
    const jobs: StoredJob[] = [];
    const metaIds = new Set<string>();

    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;

      const fullPath = path.join(this.options.jobsDir, file);
      try {
        const stored = JSON.parse(readFileSyncUtf8(fullPath)) as StoredJob;
        jobs.push(stored);
        metaIds.add(stored.id);
      } catch {
        continue;
      }
    }

    const now = Date.now();
    const activeIds = new Set(
      jobs
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => job.id),
    );

    for (const job of jobs) {
      if (!isTerminalStatus(job.status)) continue;
      if (!isOlderThan(jobTimestamp(job), now, this.retention.metaDays)) continue;

      this.deleteJobFiles(job.id, { meta: true, events: true });
      this.jobs.delete(job.id);
      this.events.delete(job.id);
      metaIds.delete(job.id);
    }

    this.pruneEventLogs(
      jobs.filter((job) => job.status === "succeeded"),
      this.retention.succeededEventLogDays,
      this.retention.succeededEventLogCount,
      now,
    );
    this.pruneEventLogs(
      jobs.filter(
        (job) =>
          job.status === "failed" ||
          job.status === "cancelled" ||
          job.status === "interrupted",
      ),
      this.retention.otherEventLogDays,
      this.retention.otherEventLogCount,
      now,
    );

    for (const { jobId } of this.listEventLogFiles()) {
      if (metaIds.has(jobId) || activeIds.has(jobId)) continue;

      this.deleteJobFiles(jobId, { events: true });
    }
  }

  private pruneEventLogs(
    jobs: StoredJob[],
    maxAgeDays: number,
    keepCount: number,
    now: number,
  ) {
    const sorted = [...jobs].sort((a, b) => jobTimestamp(b) - jobTimestamp(a));

    sorted.forEach((job, index) => {
      if (job.status === "queued" || job.status === "running") return;
      if (index < keepCount && !isOlderThan(jobTimestamp(job), now, maxAgeDays)) return;

      this.deleteJobFiles(job.id, { events: true });
      this.events.delete(job.id);
    });
  }

  private deleteJobFiles(jobId: string, options: { meta?: boolean; events?: boolean }) {
    if (options.meta) {
      deleteIfExists(this.jobMetaPath(jobId));
    }
    if (options.events) {
      deleteIfExists(this.jobLogPath(jobId));
      deleteIfExists(this.legacyJobLogPath(jobId));
    }
  }

  private storedJob(job: Job): StoredJob {
    const { content: _content, ...stored } = job;
    return stored;
  }

  private publicJob(job: Job): PublicJob {
    const { content: _content, ...publicJob } = job;
    return {
      ...publicJob,
      metrics: cloneJobMetrics(ensureJobMetrics(job)),
    };
  }

  private eventName(jobId: string) {
    return `job:${jobId}`;
  }

  private jobMetaPath(jobId: string) {
    return path.join(this.options.jobsDir, `${jobId}.meta.json`);
  }

  private jobLogPath(jobId: string) {
    return path.join(this.rawEventLogsDir(), `${jobId}.jsonl`);
  }

  private legacyJobLogPath(jobId: string) {
    return path.join(this.options.jobsDir, `${jobId}.jsonl`);
  }

  private resolveJobLogPath(jobId: string) {
    const currentPath = this.jobLogPath(jobId);
    if (existsSync(currentPath)) return currentPath;
    return this.legacyJobLogPath(jobId);
  }

  private rawEventLogsDir() {
    return path.join(this.options.jobsDir, RAW_EVENT_LOGS_DIR_NAME);
  }

  private listEventLogFiles() {
    const files: Array<{ jobId: string }> = [];
    const seen = new Set<string>();
    for (const directory of [this.rawEventLogsDir(), this.options.jobsDir]) {
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory)) {
        if (!file.endsWith(".jsonl")) continue;
        const jobId = file.slice(0, -".jsonl".length);
        if (seen.has(jobId)) continue;
        seen.add(jobId);
        files.push({ jobId });
      }
    }
    return files;
  }

  private migrateLegacyEventLogs() {
    if (!existsSync(this.options.jobsDir)) return;
    for (const file of readdirSync(this.options.jobsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const jobId = file.slice(0, -".jsonl".length);
      const source = this.legacyJobLogPath(jobId);
      const target = this.jobLogPath(jobId);
      if (existsSync(target)) {
        mergeLegacyEventLog(source, target);
        continue;
      }
      try {
        renameSync(source, target);
      } catch (error) {
        console.error("[wiki-server] failed to migrate legacy job event log", error);
      }
    }
  }
}

type AverageAccumulator = {
  sum: number;
  count: number;
};

type ObservabilityVisit = {
  value: unknown;
  key: string;
  depth: number;
};

type ExtractedFileObservability = {
  readFilePaths: string[];
  writeFilePaths: string[];
  ambiguousFilePaths: string[];
};

type FileAccessKind = "read" | "write" | "ambiguous";

function ensureJobMetrics(job: Job): JobMetrics {
  job.metrics = normalizeJobMetrics(job);
  return job.metrics;
}

function updateStartedMetrics(job: Job) {
  const metrics = ensureJobMetrics(job);
  const queueWaitMs = elapsedMs(job.createdAt, job.startedAt);
  if (queueWaitMs !== undefined) {
    metrics.queueWaitMs = queueWaitMs;
  }
}

function updateFinishedMetrics(job: Job) {
  const metrics = ensureJobMetrics(job);
  const totalMs = elapsedMs(job.createdAt, job.finishedAt);
  const runMs = elapsedMs(job.startedAt, job.finishedAt);
  if (totalMs !== undefined) {
    metrics.totalMs = totalMs;
  }
  if (runMs !== undefined) {
    metrics.runMs = runMs;
  }
  if (job.startedAt && metrics.queueWaitMs === undefined) {
    const queueWaitMs = elapsedMs(job.createdAt, job.startedAt);
    if (queueWaitMs !== undefined) {
      metrics.queueWaitMs = queueWaitMs;
    }
  }
}

function applyAgentObservability(job: Job, event: unknown) {
  const metrics = ensureJobMetrics(job);
  const tokenUsage = extractTokenUsage(event);
  if (tokenUsage) {
    metrics.tokenUsageHighWater = mergeTokenUsage(metrics.tokenUsageHighWater, tokenUsage);
  }

  const fileObservability = extractFileObservability(event);
  if (
    fileObservability.readFilePaths.length > 0 ||
    fileObservability.writeFilePaths.length > 0 ||
    fileObservability.ambiguousFilePaths.length > 0
  ) {
    const readFilePaths = mergeObservedFilePaths(
      metrics.fileObservability?.readFilePaths,
      fileObservability.readFilePaths,
    );
    const writeFilePaths = mergeObservedFilePaths(
      metrics.fileObservability?.writeFilePaths,
      fileObservability.writeFilePaths,
    );
    const ambiguousFilePaths = mergeObservedFilePaths(
      metrics.fileObservability?.ambiguousFilePaths,
      fileObservability.ambiguousFilePaths,
    );

    metrics.fileObservability = makeFileObservability(
      readFilePaths,
      writeFilePaths,
      ambiguousFilePaths,
    );
  }
}

function normalizeJobMetrics(job: Partial<Pick<Job, "metrics" | "createdAt" | "startedAt" | "finishedAt">>): JobMetrics {
  const rawMetrics = job.metrics as
    | (JobMetrics & {
        tokenUsage?: JobTokenMetrics;
        referencedFilePaths?: string[];
      })
    | undefined;
  const metrics: JobMetrics = {
    queuedAheadCount: sanitizeNonNegativeInteger(rawMetrics?.queuedAheadCount) ?? 0,
  };

  const queueWaitMs = sanitizeNonNegativeInteger(
    rawMetrics?.queueWaitMs ?? elapsedMs(job.createdAt, job.startedAt),
  );
  const runMs = sanitizeNonNegativeInteger(
    rawMetrics?.runMs ?? elapsedMs(job.startedAt, job.finishedAt),
  );
  const totalMs = sanitizeNonNegativeInteger(
    rawMetrics?.totalMs ?? elapsedMs(job.createdAt, job.finishedAt),
  );
  if (queueWaitMs !== undefined) metrics.queueWaitMs = queueWaitMs;
  if (runMs !== undefined) metrics.runMs = runMs;
  if (totalMs !== undefined) metrics.totalMs = totalMs;

  const tokenUsage = normalizeTokenUsage(rawMetrics?.tokenUsageHighWater ?? rawMetrics?.tokenUsage);
  if (tokenUsage) metrics.tokenUsageHighWater = tokenUsage;

  const rawFileObservability = rawMetrics?.fileObservability;
  const readFilePaths = mergeObservedFilePaths([], rawFileObservability?.readFilePaths ?? []);
  const writeFilePaths = mergeObservedFilePaths([], rawFileObservability?.writeFilePaths ?? []);
  const ambiguousFilePaths = mergeObservedFilePaths(
    [],
    [
      ...(rawFileObservability?.ambiguousFilePaths ?? []),
      // Legacy persisted metadata used referencedFilePaths as a broad bucket.
      // On load, anything not explicitly read/write remains ambiguous.
      ...(rawMetrics?.referencedFilePaths ?? []),
    ],
  );
  if (
    readFilePaths.length > 0 ||
    writeFilePaths.length > 0 ||
    ambiguousFilePaths.length > 0
  ) {
    metrics.fileObservability = makeFileObservability(
      readFilePaths,
      writeFilePaths,
      ambiguousFilePaths,
    );
  }

  return metrics;
}

function normalizeJobEvent(event: JobEvent): JobEvent {
  return {
    ...event,
    data: normalizeJobEventData(event.data),
  };
}

function normalizeJobEventData(data: unknown): unknown {
  if (!isPlainObject(data) || !isPublicJobSnapshot(data)) return data;
  return {
    ...data,
    metrics: normalizeJobMetrics({
      metrics: data.metrics as JobMetrics,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
      finishedAt: typeof data.finishedAt === "string" ? data.finishedAt : undefined,
    }),
  };
}

function isPublicJobSnapshot(data: Record<string, unknown>) {
  return (
    typeof data.id === "string" &&
    typeof data.status === "string" &&
    "metrics" in data
  );
}

function hasLegacyReferencedFilePathsMetric(metrics: Job["metrics"] | undefined) {
  return (
    isPlainObject(metrics) &&
    Array.isArray((metrics as { referencedFilePaths?: unknown }).referencedFilePaths)
  );
}

function cloneJobMetrics(metrics: JobMetrics): JobMetrics {
  return {
    ...metrics,
    tokenUsageHighWater: metrics.tokenUsageHighWater ? { ...metrics.tokenUsageHighWater } : undefined,
    fileObservability: cloneFileObservability(metrics.fileObservability),
  };
}

function elapsedMs(start: string | undefined, end: string | undefined) {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function makeAverageAccumulator(): AverageAccumulator {
  return { sum: 0, count: 0 };
}

function addAverageValue(accumulator: AverageAccumulator, value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  accumulator.sum += value;
  accumulator.count += 1;
}

function finishAverage(accumulator: AverageAccumulator) {
  if (accumulator.count === 0) return null;
  return Math.round(accumulator.sum / accumulator.count);
}

function extractTokenUsage(event: unknown): JobTokenMetrics | undefined {
  const result: JobTokenMetrics = {};

  visitObservabilityValues(event, (value, key) => {
    if (!isPlainObject(value)) return;

    const tokenContext = isTokenContextKey(key);
    mergeExtractedToken(result, "inputTokens", getTokenNumber(value, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      ...(tokenContext ? ["input", "prompt"] : []),
    ]));
    mergeExtractedToken(result, "outputTokens", getTokenNumber(value, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
      ...(tokenContext ? ["output", "completion"] : []),
    ]));
    mergeExtractedToken(result, "totalTokens", getTokenNumber(value, [
      "total_tokens",
      "totalTokens",
      ...(tokenContext ? ["total"] : []),
    ]));
  });

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractFileObservability(event: unknown): ExtractedFileObservability {
  const observability: ExtractedFileObservability = {
    readFilePaths: [],
    writeFilePaths: [],
    ambiguousFilePaths: [],
  };

  visitObservabilityValues(event, (value, key) => {
    if (isPlainObject(value) && isApplyPatchObject(value)) {
      for (const candidate of extractPathsFromPatchObject(value)) {
        addObservedFilePath(observability, candidate, "write");
      }
      return;
    }

    if (typeof value === "string") {
      if (isFilePathKey(key)) {
        addObservedFilePath(observability, value, fileAccessKindForKey(key));
      } else if (isCommandKey(key)) {
        mergeCommandFileObservability(observability, value);
      }
      return;
    }

    if (!Array.isArray(value)) return;
    if (!isFilePathKey(key) && !isCommandKey(key)) return;
    if (isCommandKey(key)) {
      mergeCommandFileObservability(
        observability,
        value.filter((item): item is string => typeof item === "string").join(" "),
      );
      return;
    }

    const accessKind = fileAccessKindForKey(key);
    for (const item of value.slice(0, MAX_OBSERVABILITY_ARRAY_ITEMS)) {
      if (typeof item !== "string") continue;
      addObservedFilePath(observability, item, accessKind);
    }
  });

  return observability;
}

function visitObservabilityValues(
  root: unknown,
  visitor: (value: unknown, key: string) => void,
) {
  const stack: ObservabilityVisit[] = [{ value: root, key: "", depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_OBSERVABILITY_NODES) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    visitor(current.value, current.key);

    if (current.depth >= MAX_OBSERVABILITY_DEPTH) continue;
    if (!current.value || typeof current.value !== "object") continue;

    if (Array.isArray(current.value)) {
      const items = current.value.slice(0, MAX_OBSERVABILITY_ARRAY_ITEMS);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        stack.push({ value: items[index], key: current.key, depth: current.depth + 1 });
      }
      continue;
    }

    for (const [childKey, childValue] of Object.entries(current.value).reverse()) {
      stack.push({ value: childValue, key: childKey, depth: current.depth + 1 });
    }
  }
}

function mergeTokenUsage(
  current: JobTokenMetrics | undefined,
  next: JobTokenMetrics,
): JobTokenMetrics {
  return normalizeTokenUsage({
    inputTokens: maxTokenValue(current?.inputTokens, next.inputTokens),
    outputTokens: maxTokenValue(current?.outputTokens, next.outputTokens),
    totalTokens: maxTokenValue(current?.totalTokens, next.totalTokens),
  }) ?? {};
}

function normalizeTokenUsage(value: JobTokenMetrics | undefined): JobTokenMetrics | undefined {
  if (!value) return undefined;
  const normalized: JobTokenMetrics = {};
  const inputTokens = sanitizeNonNegativeInteger(value.inputTokens);
  const outputTokens = sanitizeNonNegativeInteger(value.outputTokens);
  const totalTokens = sanitizeNonNegativeInteger(value.totalTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function maxTokenValue(current: number | undefined, next: number | undefined) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

function mergeExtractedToken(
  metrics: JobTokenMetrics,
  key: keyof JobTokenMetrics,
  value: number | undefined,
) {
  const sanitized = sanitizeNonNegativeInteger(value);
  if (sanitized === undefined) return;
  metrics[key] = maxTokenValue(metrics[key], sanitized);
}

function getTokenNumber(object: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function mergeObservedFilePaths(
  current: string[] | undefined,
  next: string[],
): string[] {
  const merged: string[] = [];
  for (const candidate of [...(current ?? []), ...next]) {
    addObservedFilePathToList(merged, candidate);
  }
  return merged;
}

function makeFileObservability(
  readFilePaths: string[],
  writeFilePaths: string[],
  ambiguousFilePaths: string[],
): JobFileObservability {
  const normalizedReadFilePaths = mergeObservedFilePaths([], readFilePaths);
  const normalizedWriteFilePaths = mergeObservedFilePaths([], writeFilePaths);
  const classifiedFilePaths = new Set([
    ...normalizedReadFilePaths,
    ...normalizedWriteFilePaths,
  ]);
  const normalizedAmbiguousFilePaths = mergeObservedFilePaths([], ambiguousFilePaths).filter(
    (filePath) => !classifiedFilePaths.has(filePath),
  );
  const observability: JobFileObservability = {};
  if (normalizedReadFilePaths.length > 0) {
    observability.readFilePaths = normalizedReadFilePaths;
  }
  if (normalizedWriteFilePaths.length > 0) {
    observability.writeFilePaths = normalizedWriteFilePaths;
  }
  if (normalizedAmbiguousFilePaths.length > 0) {
    observability.ambiguousFilePaths = normalizedAmbiguousFilePaths;
  }
  return observability;
}

function cloneFileObservability(
  observability: JobFileObservability | undefined,
): JobFileObservability | undefined {
  if (!observability) return undefined;
  const cloned: JobFileObservability = {};
  if (observability.readFilePaths) {
    cloned.readFilePaths = [...observability.readFilePaths];
  }
  if (observability.writeFilePaths) {
    cloned.writeFilePaths = [...observability.writeFilePaths];
  }
  if (observability.ambiguousFilePaths) {
    cloned.ambiguousFilePaths = [...observability.ambiguousFilePaths];
  }
  return cloned;
}

function addObservedFilePath(
  observability: ExtractedFileObservability,
  candidate: string,
  accessKind: FileAccessKind,
) {
  const normalized = normalizeReferencedFilePath(candidate);
  if (!normalized || !looksLikeFilePath(normalized) || isIgnoredObservedFilePath(normalized)) return;
  if (accessKind === "read") {
    addObservedFilePathToList(observability.readFilePaths, normalized);
  } else if (accessKind === "write") {
    addObservedFilePathToList(observability.writeFilePaths, normalized);
  } else {
    addObservedFilePathToList(observability.ambiguousFilePaths, normalized);
  }
}

function addObservedFilePathToList(paths: string[], candidate: string) {
  const normalized = normalizeReferencedFilePath(candidate);
  if (!normalized || !looksLikeFilePath(normalized) || isIgnoredObservedFilePath(normalized)) return;
  if (paths.includes(normalized)) return;
  paths.push(normalized);
}

function normalizeReferencedFilePath(candidate: string) {
  const trimmed = candidate.trim().replace(/^["'`]+|["'`,;:]+$/g, "");
  if (!trimmed || trimmed.length > MAX_OBSERVABILITY_STRING_LENGTH) return undefined;
  return trimmed;
}

function extractPathsFromCommand(command: string) {
  if (command.length > MAX_OBSERVABILITY_STRING_LENGTH) return [];
  const paths: string[] = [];
  const quotedPathPattern = /(["'`])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^"'`<>|]+?)\1/g;
  for (const match of command.matchAll(quotedPathPattern)) {
    if (match[2]) {
      addObservedFilePathToList(paths, match[2]);
    }
  }

  const unquotedPathPattern = /[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;
  for (const match of command.matchAll(unquotedPathPattern)) {
    const candidate = match[0];
    const end = (match.index ?? 0) + candidate.length;
    if (isLikelySplitUnquotedPath(command, candidate, end)) continue;
    addObservedFilePathToList(paths, candidate);
  }

  return paths;
}

function mergeCommandFileObservability(
  observability: ExtractedFileObservability,
  command: string,
) {
  if (!command || command.length > MAX_OBSERVABILITY_STRING_LENGTH) return;
  const accessKind = fileAccessKindForCommand(command);
  for (const candidate of extractPathsFromCommand(command)) {
    addObservedFilePath(observability, candidate, accessKind);
  }
}

function fileAccessKindForKey(key: string): FileAccessKind {
  if (/^(read|reads|readFiles|read_files)$/i.test(key)) return "read";
  if (
    /^(write|writes|writeFiles|write_files|created|createdFiles|created_files|deleted|deletedFiles|deleted_files|modified|modifiedFiles|modified_files)$/i.test(
      key,
    )
  ) {
    return "write";
  }
  return "ambiguous";
}

function fileAccessKindForCommand(command: string): FileAccessKind {
  if (isWriteCommand(command)) return "write";
  if (isReadCommand(command)) return "read";
  return "ambiguous";
}

function isReadCommand(command: string) {
  return (
    /\b(Get-Content|gc|Select-String|rg|grep|findstr|type|Get-ChildItem|dir|ls)\b/i.test(command) ||
    /\bgit\s+(show|diff|status|log|grep|ls-files|blame)\b/i.test(command)
  );
}

function isWriteCommand(command: string) {
  return (
    /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item)\b/i.test(
      command,
    ) ||
    /\b(del|erase|rm|mv|cp|mkdir|touch)\b/i.test(command) ||
    /\bapply_patch\b/i.test(command) ||
    />{1,2}\s*[^>&]/.test(command)
  );
}

function isApplyPatchObject(value: Record<string, unknown>) {
  return Object.entries(value).some(
    ([key, childValue]) =>
      /^(tool|name|recipient_name|function)$/i.test(key) &&
      typeof childValue === "string" &&
      /apply_patch/i.test(childValue),
  );
}

function extractPathsFromPatchObject(value: Record<string, unknown>) {
  const paths: string[] = [];
  for (const childValue of Object.values(value)) {
    if (typeof childValue !== "string") continue;
    for (const candidate of extractPathsFromPatch(childValue)) {
      addObservedFilePathToList(paths, candidate);
    }
  }
  return paths;
}

function extractPathsFromPatch(patch: string) {
  const paths: string[] = [];
  const maxChars = Math.min(patch.length, MAX_PATCH_HEADER_SCAN_CHARS);
  let line = "";
  let lineTooLong = false;
  let lineCount = 0;

  for (let index = 0; index <= maxChars && lineCount < MAX_PATCH_HEADER_SCAN_LINES; index += 1) {
    const char = index < maxChars ? patch[index] : "\n";
    if (char === "\r") continue;

    if (char === "\n") {
      if (!lineTooLong) {
        addPathFromPatchHeaderLine(paths, line);
      }
      line = "";
      lineTooLong = false;
      lineCount += 1;
      continue;
    }

    if (lineTooLong) continue;
    if (line.length >= MAX_PATCH_HEADER_LINE_LENGTH) {
      lineTooLong = true;
      line = "";
      continue;
    }
    line += char;
  }

  return paths;
}

function addPathFromPatchHeaderLine(paths: string[], line: string) {
  const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/);
  if (match?.[1]) {
    addObservedFilePathToList(paths, match[1]);
  }
}

function looksLikeFilePath(value: string) {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function isIgnoredObservedFilePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (lower.endsWith("/pwsh.exe") && lower.includes("/windowsapps/")) return true;
  if (lower.endsWith("/powershell.exe") && lower.includes("/windows/system32/")) return true;
  if (looksLikeUnsupportedRelativeDirectory(normalized)) return true;
  if (looksLikeRegexFragment(normalized)) return true;
  return false;
}

function looksLikeUnsupportedRelativeDirectory(value: string) {
  if (/^(?:[A-Za-z]:|\.{1,2}\/)/.test(value)) return false;
  const firstSegment = value.split("/")[0]?.toLowerCase();
  return ![
    "build",
    "docs",
    "inbox",
    "raw",
    "runtime",
    "source-tool-seed",
    "src",
    "templates",
    "tests",
    "tools",
    "wiki",
  ].includes(firstSegment);
}

function looksLikeRegexFragment(value: string) {
  return (
    /^-{2,}\//.test(value) ||
    /^[A-Za-z_]+\/[dgimsuvy]+$/.test(value) ||
    /\/s\*/.test(value) ||
    /\/S\+/.test(value) ||
    /[()[\]{}|]/.test(value)
  );
}

function isLikelySplitUnquotedPath(command: string, candidate: string, end: number) {
  const normalized = candidate.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(normalized)) return false;
  if (path.extname(normalized)) return false;

  const rest = command.slice(end);
  return /^\s+[A-Za-z0-9_.-]+[\\/]/.test(rest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTokenContextKey(key: string) {
  return /usage|token/i.test(key);
}

function isFilePathKey(key: string) {
  return /^(path|paths|file|files|filePath|file_path|filepath|read|reads|readFiles|read_files|write|writes|writeFiles|write_files|created|createdFiles|created_files|deleted|deletedFiles|deleted_files|modified|modifiedFiles|modified_files)$/i.test(key);
}

function isCommandKey(key: string) {
  return /^(command|cmd|args|argv|script)$/i.test(key);
}

function sanitizeNonNegativeInteger(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function makeContentPreview(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function isTerminalStatus(status: JobStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function jobTimestamp(job: Pick<Job, "finishedAt" | "updatedAt" | "createdAt">) {
  return Date.parse(job.finishedAt ?? job.updatedAt ?? job.createdAt);
}

function isOlderThan(timestamp: number, now: number, days: number) {
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > days * 24 * 60 * 60 * 1000;
}

function readFileSyncUtf8(filePath: string) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function deleteIfExists(filePath: string) {
  if (!existsSync(filePath)) return;
  rmSync(filePath, { force: true });
}

function tryBackfillStoredJob(filePath: string, job: StoredJob) {
  try {
    writeFileSync(filePath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[wiki-server] failed to backfill persisted job metadata", error);
  }
}

function mergeLegacyEventLog(source: string, target: string) {
  try {
    const targetContent = readFileSyncUtf8(target);
    const targetLines = targetContent.split(/\r?\n/).filter(Boolean);
    const existing = new Set(targetLines);
    const missingLines = readFileSyncUtf8(source)
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !existing.has(line));
    if (missingLines.length > 0) {
      const separator = targetContent.endsWith("\n") || targetContent.length === 0 ? "" : "\n";
      writeFileSync(target, `${targetContent}${separator}${missingLines.join("\n")}\n`, "utf8");
    }
    deleteIfExists(source);
  } catch (error) {
    console.error("[wiki-server] failed to merge legacy job event log", error);
  }
}
