import path from "node:path";
import type { Job, JobEvent, JobFileObservability, JobMetrics, JobTokenMetrics } from "./jobTypes.js";
import {
  applyRetrievalObservability,
  cloneRetrievalObservability,
  normalizeRetrievalObservability,
} from "./retrievalMetrics.js";

const MAX_OBSERVABILITY_DEPTH = 8;
const MAX_OBSERVABILITY_NODES = 500;
const MAX_OBSERVABILITY_ARRAY_ITEMS = 50;
const MAX_OBSERVABILITY_STRING_LENGTH = 4096;
const MAX_PATCH_HEADER_SCAN_CHARS = 256 * 1024;
const MAX_PATCH_HEADER_SCAN_LINES = 5000;
const MAX_PATCH_HEADER_LINE_LENGTH = 2048;

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

export function ensureJobMetrics(job: Job): JobMetrics {
  job.metrics = normalizeJobMetrics(job);
  return job.metrics;
}

export function updateStartedMetrics(job: Job) {
  const metrics = ensureJobMetrics(job);
  const queueWaitMs = elapsedMs(job.createdAt, job.startedAt);
  if (queueWaitMs !== undefined) {
    metrics.queueWaitMs = queueWaitMs;
  }
}

export function updateFinishedMetrics(job: Job) {
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

export function applyAgentObservability(job: Job, event: unknown) {
  const metrics = ensureJobMetrics(job);
  const tokenUsage = extractTokenUsage(event);
  if (tokenUsage) {
    metrics.tokenUsageHighWater = mergeTokenUsage(metrics.tokenUsageHighWater, tokenUsage);
  }

  const fileObservability = extractFileObservability(event);
  metrics.retrievalObservability = applyRetrievalObservability(
    metrics.retrievalObservability,
    event,
    fileObservability,
  );
  if (!metrics.retrievalObservability) delete metrics.retrievalObservability;
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

export function normalizeJobMetrics(job: Partial<Pick<Job, "metrics" | "createdAt" | "startedAt" | "finishedAt">>): JobMetrics {
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

  const retrievalObservability = normalizeRetrievalObservability(rawMetrics?.retrievalObservability);
  if (retrievalObservability) metrics.retrievalObservability = retrievalObservability;

  return metrics;
}

export function normalizeJobEvent(event: JobEvent): JobEvent {
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

export function hasLegacyReferencedFilePathsMetric(metrics: Job["metrics"] | undefined) {
  return (
    isPlainObject(metrics) &&
    Array.isArray((metrics as { referencedFilePaths?: unknown }).referencedFilePaths)
  );
}

export function cloneJobMetrics(metrics: JobMetrics): JobMetrics {
  return {
    ...metrics,
    tokenUsageHighWater: metrics.tokenUsageHighWater ? { ...metrics.tokenUsageHighWater } : undefined,
    fileObservability: cloneFileObservability(metrics.fileObservability),
    retrievalObservability: cloneRetrievalObservability(metrics.retrievalObservability),
  };
}

function elapsedMs(start: string | undefined, end: string | undefined) {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

export function makeAverageAccumulator(): AverageAccumulator {
  return { sum: 0, count: 0 };
}

export function addAverageValue(accumulator: AverageAccumulator, value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  accumulator.sum += value;
  accumulator.count += 1;
}

export function finishAverage(accumulator: AverageAccumulator) {
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
