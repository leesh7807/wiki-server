import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
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
} from "./jobTypes.js";
import {
  ensureJobMetrics,
  updateStartedMetrics,
  updateFinishedMetrics,
  applyAgentObservability,
  normalizeJobMetrics,
  normalizeJobEvent,
  hasLegacyReferencedFilePathsMetric,
  cloneJobMetrics,
  makeAverageAccumulator,
  addAverageValue,
  finishAverage,
} from "./jobMetrics.js";

export type JobStoreOptions = {
  jobsDir: string;
  heartbeatMs: number;
  compressEventLogs?: boolean;
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
const COMPRESSED_EVENT_DATA_THRESHOLD_BYTES = 4096;
const COMPRESSED_EVENT_STORAGE_VERSION = 1;

type CompressedEventStorageRecord = Omit<JobEvent, "data"> & {
  _wikiServerStorage: {
    version: 1;
    encoding: "gzip-base64";
    originalBytes: number;
    data: string;
  };
};

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
          const metricsBefore = metricsFingerprint(current.metrics);
          applyAgentObservability(current, event);
          if (metricsFingerprint(current.metrics) !== metricsBefore) {
            this.persistJob(current);
          }
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
    this.releaseTerminalEventsAfterPersist(job.id);
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
    const line = `${encodeStoredEventLine(event, this.options.compressEventLogs !== false)}\n`;
    this.enqueuePersist(() => appendFile(logPath, line, "utf8"));
  }

  private enqueuePersist(operation: () => Promise<void>) {
    const run = this.persistQueue.then(operation, operation);
    this.persistQueue = run.catch(() => undefined);
    void run.catch((error) => {
      console.error("[wiki-server] failed to persist job store", error);
    });
  }

  private releaseTerminalEventsAfterPersist(jobId: string) {
    const persisted = this.persistQueue;
    void persisted.then(() => {
      const job = this.jobs.get(jobId);
      if (job && isTerminalStatus(job.status)) {
        this.events.delete(jobId);
      }
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
        const event = parseStoredEventLine(line);
        if (!event) continue;
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


function makeContentPreview(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function metricsFingerprint(metrics: JobMetrics | undefined) {
  return metrics ? JSON.stringify(metrics) : "";
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
    const existingLines = new Set(targetLines);
    const existingEvents = new Set(targetLines.map(storedEventIdentity).filter(Boolean));
    const missingLines = readFileSyncUtf8(source)
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        if (existingLines.has(line)) return false;
        const identity = storedEventIdentity(line);
        return !identity || !existingEvents.has(identity);
      });
    if (missingLines.length > 0) {
      const separator = targetContent.endsWith("\n") || targetContent.length === 0 ? "" : "\n";
      writeFileSync(target, `${targetContent}${separator}${missingLines.join("\n")}\n`, "utf8");
    }
    deleteIfExists(source);
  } catch (error) {
    console.error("[wiki-server] failed to merge legacy job event log", error);
  }
}

function encodeStoredEventLine(event: JobEvent, compress: boolean) {
  const plain = JSON.stringify(event);
  if (!compress) return plain;
  const serializedData = JSON.stringify(event.data);
  if (!serializedData) return plain;
  const originalBytes = Buffer.byteLength(serializedData, "utf8");
  if (originalBytes < COMPRESSED_EVENT_DATA_THRESHOLD_BYTES) return plain;
  try {
    const compressed: CompressedEventStorageRecord = {
      seq: event.seq,
      at: event.at,
      jobId: event.jobId,
      event: event.event,
      _wikiServerStorage: {
        version: COMPRESSED_EVENT_STORAGE_VERSION,
        encoding: "gzip-base64",
        originalBytes,
        data: gzipSync(Buffer.from(serializedData, "utf8")).toString("base64"),
      },
    };
    const encoded = JSON.stringify(compressed);
    return Buffer.byteLength(encoded, "utf8") < Buffer.byteLength(plain, "utf8") ? encoded : plain;
  } catch {
    return plain;
  }
}

function parseStoredEventLine(line: string): JobEvent | undefined {
  const parsed = JSON.parse(line) as JobEvent | CompressedEventStorageRecord;
  if (!isCompressedEventStorageRecord(parsed)) return parsed as JobEvent;
  const serializedData = gunzipSync(Buffer.from(parsed._wikiServerStorage.data, "base64"))
    .toString("utf8");
  if (Buffer.byteLength(serializedData, "utf8") !== parsed._wikiServerStorage.originalBytes) {
    return undefined;
  }
  return {
    seq: parsed.seq,
    at: parsed.at,
    jobId: parsed.jobId,
    event: parsed.event,
    data: JSON.parse(serializedData),
  };
}

function isCompressedEventStorageRecord(
  value: JobEvent | CompressedEventStorageRecord,
): value is CompressedEventStorageRecord {
  const storage = (value as Partial<CompressedEventStorageRecord>)._wikiServerStorage;
  return storage?.version === COMPRESSED_EVENT_STORAGE_VERSION &&
    storage.encoding === "gzip-base64" && typeof storage.originalBytes === "number" &&
    typeof storage.data === "string";
}

function storedEventIdentity(line: string) {
  try {
    const event = parseStoredEventLine(line);
    return event ? `${event.jobId}:${event.seq}` : undefined;
  } catch {
    return undefined;
  }
}
