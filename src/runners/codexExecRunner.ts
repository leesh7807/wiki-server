import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatJobInput } from "../jobs/jobCommand.js";
import type { Job, JobError, RunningProcess, RunnerResult } from "../jobs/jobTypes.js";

const STDERR_TAIL_LIMIT = 16_384;

export type CodexRunnerOptions = {
  codexBin: string;
  wikiRoot: string;
  codexHome: string;
  model?: string;
  reasoningEffort?: string;
  input?: string;
  onAgentEvent: (event: unknown) => void;
};

export function startCodexJob(
  job: Job,
  options: CodexRunnerOptions,
): RunningProcess {
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--cd",
    options.wikiRoot,
    "--sandbox",
    "danger-full-access",
    "--ephemeral",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  }
  args.push("-");

  const child = spawn(options.codexBin, args, {
    cwd: options.wikiRoot,
    env: makeCodexEnvironment(options.codexHome),
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" && !options.codexBin.toLowerCase().endsWith(".exe"),
  });

  let stdoutBuffer = "";
  let stderrTail = "";
  let lastAgentMessage: string | undefined;
  let spawnError: JobError | undefined;
  let cancelled = false;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const appendStderr = (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  };

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      lastAgentMessage = extractAgentMessage(parsed) ?? lastAgentMessage;
      options.onAgentEvent(parsed);
    } catch (error) {
      appendStderr(`[non-json stdout ignored] ${trimmed}\n`);
    }
  };

  child.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += stdoutDecoder.write(data);
    let newlineIndex = stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      consumeLine(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    appendStderr(stderrDecoder.write(data));
  });

  child.on("error", (error) => {
    spawnError = {
      message: `failed to start Codex process: ${error.message}`,
      stderrTail,
      lastAgentMessage,
    };
  });

  child.stdin.end(options.input ?? formatJobInput(job.command, job.content));

  const done = new Promise<RunnerResult>((resolve) => {
    child.on("close", (code, signal) => {
      stdoutBuffer += stdoutDecoder.end();
      appendStderr(stderrDecoder.end());
      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer);
        stdoutBuffer = "";
      }

      if (cancelled) {
        resolve({
          ok: false,
          error: {
            message: "job cancelled",
            exitCode: code,
            signal,
            stderrTail,
            lastAgentMessage,
          },
        });
        return;
      }

      if (spawnError) {
        resolve({ ok: false, error: spawnError });
        return;
      }

      if (code === 0) {
        resolve({ ok: true, result: { lastAgentMessage, stderrTail } });
        return;
      }

      resolve({
        ok: false,
        error: {
          message: `Codex process exited with code ${code ?? "null"}`,
          exitCode: code,
          signal,
          stderrTail,
          lastAgentMessage,
        },
      });
    });
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      if (child.pid && process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else if (!child.killed) {
        child.kill();
      }
    },
  };
}

export function makeCodexEnvironment(
  codexHome: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    CODEX_HOME: codexHome,
  };
}

function extractAgentMessage(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = "item" in event ? (event as { item?: unknown }).item : undefined;
  if (!item || typeof item !== "object") return undefined;

  const typedItem = item as { type?: unknown; text?: unknown };
  if (typedItem.type === "agent_message" && typeof typedItem.text === "string") {
    return typedItem.text;
  }

  return undefined;
}
