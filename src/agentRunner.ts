import path from "node:path";
import {
  CodexAppServerManager,
  type CodexAppServerRunnerOptions,
} from "./appServerRunner.js";
import { startCodexJob } from "./codexRunner.js";
import type { Job, JobCommand, RunnerResult, RunningProcess } from "./types.js";

const DEFAULT_WARMUP_FAILURE_FALLBACK_MS = 60_000;

export type AgentRunnerMode = "app-server" | "exec";

export type AgentRunnerOptions = {
  mode: AgentRunnerMode;
  codexBin: string;
  wikiRoot: string;
  appServerCodexHome: string;
  appServerPort?: number;
  appServerReservedPorts?: number[];
  appServerModel?: string;
  appServerModels?: Partial<Record<JobCommand, string>>;
  appServerReasoningEffort?: string;
  appServerReasoningEfforts?: Partial<Record<JobCommand, string>>;
  appServerServiceTier?: string;
  warmupEnabled: boolean;
  warmupFailureFallbackMs?: number;
};

export type RunnerHooks = {
  onAgentEvent: (event: unknown) => void;
};

type AppServerRunningProcess = RunningProcess & {
  canFallbackAfterFailure: () => boolean;
};

export type AppServerManagerLike = {
  startJob: (job: Job, options: CodexAppServerRunnerOptions) => AppServerRunningProcess;
  warmUp: (
    options: Omit<CodexAppServerRunnerOptions, "onAgentEvent">,
  ) => Promise<RunnerResult>;
  status: () => unknown;
  stop: () => void;
};

type ExecRunnerStarter = (
  job: Job,
  options: {
    codexBin: string;
    wikiRoot: string;
    model?: string;
    reasoningEffort?: string;
    onAgentEvent: (event: unknown) => void;
  },
) => RunningProcess;

export type AgentRunnerDependencies = {
  appServer?: AppServerManagerLike;
  startExecJob?: ExecRunnerStarter;
};

export class AgentRunner {
  private readonly appServer: AppServerManagerLike;
  private readonly startExecRunner: ExecRunnerStarter;
  private readonly activeProcesses = new Set<RunningProcess>();
  private warmupRetry: Promise<RunnerResult | undefined> | undefined;
  private warmupStatus:
    | {
        status: "disabled";
      }
    | {
        status: "idle" | "running" | "succeeded" | "failed";
        startedAt?: string;
        finishedAt?: string;
        retryAfter?: string;
        error?: string;
      };

  constructor(
    private readonly options: AgentRunnerOptions,
    dependencies: AgentRunnerDependencies = {},
  ) {
    this.appServer = dependencies.appServer ?? new CodexAppServerManager();
    this.startExecRunner = dependencies.startExecJob ?? startCodexJob;
    this.warmupStatus = options.warmupEnabled ? { status: "idle" } : { status: "disabled" };
  }

  startJob(job: Job, hooks: RunnerHooks): RunningProcess {
    if (this.options.mode === "exec") {
      return this.trackProcess(this.startExecJob(job, hooks));
    }

    if (this.warmupStatus.status === "failed") {
      const retryAfter = Date.parse(this.warmupStatus.retryAfter ?? "");
      const error = this.warmupStatus.error;
      if (Number.isFinite(retryAfter) && Date.now() >= retryAfter) {
        this.scheduleWarmupRetry();
      }
      hooks.onAgentEvent(
        makeFallbackEvent(`app-server warmup failed: ${error ?? "unknown error"}`),
      );
      return this.trackProcess(this.startExecJob(job, hooks));
    }

    if (this.warmupRetry) {
      hooks.onAgentEvent(makeFallbackEvent("app-server warmup retry is still running"));
      return this.trackProcess(this.startExecJob(job, hooks));
    }

    let appProcess: ReturnType<CodexAppServerManager["startJob"]>;
    try {
      appProcess = this.appServer.startJob(job, {
        codexBin: this.options.codexBin,
        wikiRoot: this.options.wikiRoot,
        codexHome: this.options.appServerCodexHome,
        port: this.options.appServerPort,
        reservedPorts: this.options.appServerReservedPorts,
        model: this.modelFor(job.command),
        reasoningEffort: this.reasoningEffortFor(job.command),
        serviceTier: this.options.appServerServiceTier,
        onAgentEvent: hooks.onAgentEvent,
      });
    } catch (error) {
      this.markAppServerUnavailable(error);
      hooks.onAgentEvent(makeFallbackEvent(error));
      return this.trackProcess(this.startExecJob(job, hooks));
    }

    const trackedAppProcess = this.trackProcess(appProcess);
    let fallbackProcess: RunningProcess | undefined;
    let cancelled = false;
    const done = (async () => {
      const result = await trackedAppProcess.done;
      if (result.ok || cancelled || !appProcess.canFallbackAfterFailure()) {
        if (result.ok) {
          this.markAppServerRecovered();
        }
        return result;
      }

      hooks.onAgentEvent(makeFallbackEvent(result.error.message));
      this.markAppServerUnavailable(result.error.message);
      fallbackProcess = this.trackProcess(this.startExecJob(job, hooks));
      return fallbackProcess.done;
    })();

    return this.trackProcess({
      done,
      cancel: () => {
        cancelled = true;
        trackedAppProcess.cancel();
        fallbackProcess?.cancel();
      },
    });
  }

  status() {
    return {
      mode: this.options.mode,
      appServerCodexHome: path.resolve(this.options.appServerCodexHome),
      appServerPort: this.options.appServerPort,
      appServerModel: this.options.appServerModel,
      appServerModels: this.options.appServerModels,
      appServerReasoningEffort: this.options.appServerReasoningEffort,
      appServerReasoningEfforts: this.options.appServerReasoningEfforts,
      appServerServiceTier: this.options.appServerServiceTier,
      appServer: this.appServer.status(),
      warmup: this.warmupStatus,
    };
  }

  async warmUp(): Promise<RunnerResult | undefined> {
    if (this.options.mode !== "app-server" || !this.options.warmupEnabled) return undefined;
    return this.runWarmupProbe();
  }

  private async runWarmupProbe(): Promise<RunnerResult | undefined> {
    if (this.options.mode !== "app-server") return undefined;
    if (this.warmupStatus.status === "running" || this.warmupStatus.status === "succeeded") {
      return undefined;
    }

    this.warmupStatus = {
      status: "running",
      startedAt: new Date().toISOString(),
    };

    const result = await this.appServer.warmUp({
      codexBin: this.options.codexBin,
      wikiRoot: this.options.wikiRoot,
      codexHome: this.options.appServerCodexHome,
      port: this.options.appServerPort,
      reservedPorts: this.options.appServerReservedPorts,
      model: this.modelFor("query"),
      reasoningEffort: this.reasoningEffortFor("query"),
      serviceTier: this.options.appServerServiceTier,
    });

    if (result.ok) {
      this.warmupStatus = {
        status: "succeeded",
        startedAt: this.warmupStatus.startedAt,
        finishedAt: new Date().toISOString(),
      };
      return result;
    }

    this.warmupStatus = {
      status: "failed",
      startedAt: this.warmupStatus.startedAt,
      finishedAt: new Date().toISOString(),
      retryAfter: new Date(Date.now() + this.warmupFailureFallbackMs()).toISOString(),
      error: result.error.message,
    };
    return result;
  }

  stop() {
    for (const process of this.activeProcesses) {
      process.cancel();
    }
    this.activeProcesses.clear();
    this.appServer.stop();
  }

  private startExecJob(job: Job, hooks: RunnerHooks) {
    return this.startExecRunner(job, {
      codexBin: this.options.codexBin,
      wikiRoot: this.options.wikiRoot,
      model: this.modelFor(job.command),
      reasoningEffort: this.reasoningEffortFor(job.command),
      onAgentEvent: hooks.onAgentEvent,
    });
  }

  private trackProcess<T extends RunningProcess>(process: T): T {
    this.activeProcesses.add(process);
    void process.done.finally(() => {
      this.activeProcesses.delete(process);
    });
    return process;
  }

  private warmupFailureFallbackMs() {
    return this.options.warmupFailureFallbackMs ?? DEFAULT_WARMUP_FAILURE_FALLBACK_MS;
  }

  private modelFor(command: JobCommand) {
    return this.options.appServerModels?.[command] ?? this.options.appServerModel;
  }

  private reasoningEffortFor(command: JobCommand) {
    return (
      this.options.appServerReasoningEfforts?.[command] ??
      this.options.appServerReasoningEffort
    );
  }

  private scheduleWarmupRetry() {
    if (this.warmupRetry) return;
    this.warmupRetry = this.runWarmupProbe().finally(() => {
      this.warmupRetry = undefined;
    });
  }

  private markAppServerRecovered() {
    if (this.warmupStatus.status !== "failed") return;
    this.warmupStatus = {
      status: "succeeded",
      startedAt: this.warmupStatus.startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  private markAppServerUnavailable(reason: unknown) {
    this.warmupStatus = {
      status: "failed",
      startedAt: this.warmupStatus.status === "disabled" ? undefined : this.warmupStatus.startedAt,
      finishedAt: new Date().toISOString(),
      retryAfter: new Date(Date.now() + this.warmupFailureFallbackMs()).toISOString(),
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

function makeFallbackEvent(reason: unknown) {
  return {
    type: "runner_fallback",
    from: "app-server",
    to: "codex-exec",
    reason: reason instanceof Error ? reason.message : String(reason),
  };
}
