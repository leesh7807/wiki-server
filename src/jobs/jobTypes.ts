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

export type JobExecutionObservability = {
  /** Best-effort interpretation of app-server usage and completed command events. */
  evidence: "best_effort_agent_events";
  tokenUsageUpdateCount: number;
  cachedInputTokensHighWater?: number;
  nonCachedInputTokensHighWater?: number;
  maxSingleCallInputTokens?: number;
  maxSingleCallTotalTokens?: number;
  modelContextWindow?: number;
  completedCommandCount: number;
  uniqueCompletedCommandCount: number;
  repeatedCompletedCommandCount: number;
  commandOutputCharacters: number;
  commandOutputBudgetCharacters: number;
  outputBudgetViolationCount: number;
  largestCommandOutputCharacters?: number;
  largeCommandOutputCount: number;
};

export type JobFileObservability = {
  readFilePaths?: string[];
  writeFilePaths?: string[];
  ambiguousFilePaths?: string[];
};

export type JobRetrievalCoverage = {
  offered: number;
  opened: number;
  searched: number;
  used: number;
  untouched: number;
  useRatio: number | null;
};

export type JobRetrievalPartitionCoverage = {
  offered: number;
  observed: number;
  untouched: number;
};

export type JobRetrievalObservability = {
  strategy: string;
  command: JobCommand;
  mode: "candidates" | "partitions";
  /** Best-effort interpretation of completed agent tool events, not a definitive read ledger. */
  evidence: "best_effort_agent_events";
  candidatePaths?: string[];
  openedCandidatePaths?: string[];
  searchedCandidatePaths?: string[];
  candidateCoverage?: JobRetrievalCoverage;
  partitionScopes?: string[];
  observedPartitionScopes?: string[];
  partitionCoverage?: JobRetrievalPartitionCoverage;
  maintenanceCandidatePaths?: string[];
  observedMaintenanceCandidatePaths?: string[];
  otherObservedReadPaths?: string[];
  excludedPathAccesses?: string[];
  /** Compatibility counter for every search command that names an excluded path. */
  excludedPathSearchCount: number;
  /** Policy-relevant broad, recursive, wildcard, or unbounded excluded-path access. */
  broadExcludedPathAccessCount: number;
  targetedProvenanceReadCount: number;
  runtimeLogVerificationCount: number;
  repeatedReadCommandCount: number;
  /** All observed search commands, including graph and filesystem search. */
  searchCommandCount: number;
  graphSearchCommandCount: number;
  filesystemSearchCommandCount: number;
  selectiveReadCommandCount: number;
  fullDocumentReadCommandCount: number;
  broadRootSearchCount: number;
  largestSearchOutputCharacters?: number;
  policySignals?: Array<"broad_root_search" | "excluded_path_access">;
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
  executionObservability?: JobExecutionObservability;
  fileObservability?: JobFileObservability;
  retrievalObservability?: JobRetrievalObservability;
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
