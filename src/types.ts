export type JobCommand = "ingest" | "query" | "lint";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type JobError = {
  message: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  stderrTail?: string;
  lastAgentMessage?: string;
};

export type JobResult = {
  lastAgentMessage?: string;
  stderrTail?: string;
};

export type JobTokenMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type JobFileObservability = {
  readFilePaths?: string[];
  writeFilePaths?: string[];
  ambiguousFilePaths?: string[];
};

export type JobMetrics = {
  queuedAheadCount: number;
  queueWaitMs?: number;
  runMs?: number;
  totalMs?: number;
  /**
   * Best-effort cumulative/high-water token snapshot observed in agent events.
   * This is not summed billing usage.
   */
  tokenUsageHighWater?: JobTokenMetrics;
  fileObservability?: JobFileObservability;
};

export type PublicJob = {
  id: string;
  command: JobCommand;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  contentLength: number;
  contentPreview: string;
  error?: JobError;
  result?: JobResult;
  lastEventAt?: string;
  metrics: JobMetrics;
};

export type Job = Omit<PublicJob, "metrics"> & {
  content: string;
  metrics?: JobMetrics;
};

export type StoredJob = Omit<Job, "content">;

export type JobEventName = "status" | "heartbeat" | "agent_event" | "done";

export type JobEvent = {
  seq: number;
  at: string;
  jobId: string;
  event: JobEventName;
  data: unknown;
};

export type RunnerResult =
  | {
      ok: true;
      result: JobResult;
    }
  | {
      ok: false;
      error: JobError;
    };

export type RunningProcess = {
  done: Promise<RunnerResult>;
  cancel: () => void;
};

export type JobMetricsSummary = {
  counts: Record<JobStatus | "terminal" | "total", number>;
  averages: {
    queueWaitMs: number | null;
    runMs: number | null;
    totalMs: number | null;
    samples: {
      queueWaitMs: number;
      runMs: number;
      totalMs: number;
    };
  };
  current: {
    queued: Array<{
      id: string;
      command: JobCommand;
      createdAt: string;
      queuedAheadCount: number;
    }>;
    running: {
      id: string;
      command: JobCommand;
      startedAt?: string;
      queueWaitMs?: number;
      runMs?: number;
    } | null;
  };
};
