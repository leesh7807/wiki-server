import path from "node:path";
import type {
  JobCommand,
  JobRetrievalCoverage,
  JobRetrievalObservability,
} from "./jobTypes.js";

const MAX_PATHS = 50;
const MAX_EVENT_DEPTH = 8;
const MAX_EVENT_NODES = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_COMMAND_LENGTH = 64 * 1024;

type FileObservabilityDelta = {
  readFilePaths: string[];
  writeFilePaths: string[];
  ambiguousFilePaths: string[];
};

type RoutingEvent = {
  strategy: string;
  command: JobCommand;
  routing:
    | { mode: "candidates"; candidatePaths: string[] }
    | {
        mode: "partitions";
        partitionScopes: string[];
        maintenanceCandidatePaths: string[];
      };
};

export function applyRetrievalObservability(
  current: JobRetrievalObservability | undefined,
  event: unknown,
  fileDelta: FileObservabilityDelta,
) {
  const routingEvent = parseRoutingEvent(event);
  let next = routingEvent ? fromRoutingEvent(routingEvent) : cloneRetrievalObservability(current);
  if (!next || routingEvent) return next;
  if (!isCompletedCommandEvent(event)) return next;

  const commands = extractCommandStrings(event);
  const readPaths = normalizePaths(fileDelta.readFilePaths);
  for (const command of commands) {
    const search = isSearchCommand(command);
    const open = isOpenCommand(command);
    const excludedPaths = excludedPathsInCommand(command);
    const knownReadPaths = knownObservedReadPaths(next);
    if (open && knownReadPaths.some((candidate) => commandIncludesPath(command, candidate))) {
      next.repeatedReadCommandCount += 1;
    }
    if (search) {
      next.searchCommandCount += 1;
      if (isBroadRootSearch(command)) next.broadRootSearchCount += 1;
      const outputCharacters = largestOutputString(event);
      if (outputCharacters > (next.largestSearchOutputCharacters ?? 0)) {
        next.largestSearchOutputCharacters = outputCharacters;
      }
    }
    if (search && excludedPaths.length > 0) next.excludedPathSearchCount += 1;
    if (isBroadExcludedPathAccess(command, excludedPaths, open, search)) {
      next.broadExcludedPathAccessCount += 1;
    } else if (isTargetedProvenanceAccess(excludedPaths, open || search)) {
      next.targetedProvenanceReadCount += 1;
    }
    if ((open || search) && excludedPaths.some(isLogPath)) {
      next.runtimeLogVerificationCount += 1;
    }

    if (next.mode === "candidates") {
      for (const candidate of next.candidatePaths ?? []) {
        if (!commandIncludesPath(command, candidate)) continue;
        if (open) addPath(next, "openedCandidatePaths", candidate);
        if (search) addPath(next, "searchedCandidatePaths", candidate);
      }
    } else {
      observeLintRouting(next, command, open || search);
    }
    if (open || search) {
      for (const excludedPath of excludedPaths) {
        addPath(next, "excludedPathAccesses", excludedPath);
      }
    }
  }

  for (const readPath of readPaths) {
    if (isExcludedPath(readPath)) addPath(next, "excludedPathAccesses", readPath);
    if (!isWikiKnowledgePath(readPath)) continue;
    if (next.mode === "candidates") {
      const candidate = (next.candidatePaths ?? []).find((value) => pathsMatch(readPath, value));
      if (!candidate) addPath(next, "otherObservedReadPaths", readPath);
    } else {
      observeLintPath(next, readPath);
    }
  }

  refreshDerivedFields(next);
  return next;
}

export function normalizeRetrievalObservability(value: unknown) {
  if (!isRecord(value)) return undefined;
  const strategy = stringValue(value.strategy);
  const command = jobCommandValue(value.command);
  const mode = value.mode === "candidates" || value.mode === "partitions" ? value.mode : undefined;
  if (!strategy || !command || !mode) return undefined;
  const normalized: JobRetrievalObservability = {
    strategy,
    command,
    mode,
    evidence: "best_effort_agent_events",
    searchCommandCount: nonNegativeInteger(value.searchCommandCount),
    broadRootSearchCount: nonNegativeInteger(value.broadRootSearchCount),
    excludedPathSearchCount: nonNegativeInteger(value.excludedPathSearchCount),
    broadExcludedPathAccessCount: nonNegativeInteger(value.broadExcludedPathAccessCount),
    targetedProvenanceReadCount: nonNegativeInteger(value.targetedProvenanceReadCount),
    runtimeLogVerificationCount: nonNegativeInteger(value.runtimeLogVerificationCount),
    repeatedReadCommandCount: nonNegativeInteger(value.repeatedReadCommandCount),
  };
  copyPaths(value, normalized, "candidatePaths");
  copyPaths(value, normalized, "openedCandidatePaths");
  copyPaths(value, normalized, "searchedCandidatePaths");
  copyPaths(value, normalized, "partitionScopes");
  copyPaths(value, normalized, "observedPartitionScopes");
  copyPaths(value, normalized, "maintenanceCandidatePaths");
  copyPaths(value, normalized, "observedMaintenanceCandidatePaths");
  copyPaths(value, normalized, "otherObservedReadPaths");
  copyPaths(value, normalized, "excludedPathAccesses");
  const largestOutput = optionalNonNegativeInteger(value.largestSearchOutputCharacters);
  if (largestOutput !== undefined) normalized.largestSearchOutputCharacters = largestOutput;
  refreshDerivedFields(normalized);
  return normalized;
}

export function cloneRetrievalObservability(value: JobRetrievalObservability | undefined) {
  return normalizeRetrievalObservability(value);
}

function fromRoutingEvent(event: RoutingEvent): JobRetrievalObservability {
  const base: JobRetrievalObservability = {
    strategy: event.strategy,
    command: event.command,
    mode: event.routing.mode,
    evidence: "best_effort_agent_events",
    searchCommandCount: 0,
    broadRootSearchCount: 0,
    excludedPathSearchCount: 0,
    broadExcludedPathAccessCount: 0,
    targetedProvenanceReadCount: 0,
    runtimeLogVerificationCount: 0,
    repeatedReadCommandCount: 0,
  };
  if (event.routing.mode === "candidates") {
    base.candidatePaths = normalizePaths(event.routing.candidatePaths);
  } else {
    base.partitionScopes = normalizePaths(event.routing.partitionScopes);
    base.maintenanceCandidatePaths = normalizePaths(event.routing.maintenanceCandidatePaths);
  }
  refreshDerivedFields(base);
  return base;
}

function parseRoutingEvent(event: unknown): RoutingEvent | undefined {
  if (!isRecord(event) || event.type !== "retrieval_context") return undefined;
  const strategy = stringValue(event.strategy);
  const command = jobCommandValue(event.command);
  const routing = event.routing;
  if (!strategy || !command || !isRecord(routing)) return undefined;
  if (routing.mode === "candidates" && Array.isArray(routing.candidatePaths)) {
    return {
      strategy,
      command,
      routing: { mode: "candidates", candidatePaths: stringArray(routing.candidatePaths) },
    };
  }
  if (
    routing.mode === "partitions" &&
    Array.isArray(routing.partitionScopes) &&
    Array.isArray(routing.maintenanceCandidatePaths)
  ) {
    return {
      strategy,
      command,
      routing: {
        mode: "partitions",
        partitionScopes: stringArray(routing.partitionScopes),
        maintenanceCandidatePaths: stringArray(routing.maintenanceCandidatePaths),
      },
    };
  }
  return undefined;
}

function observeLintRouting(
  observability: JobRetrievalObservability,
  command: string,
  isEvidenceCommand: boolean,
) {
  if (!isEvidenceCommand) return;
  for (const scope of observability.partitionScopes ?? []) {
    if (commandIncludesPath(command, scope)) addPath(observability, "observedPartitionScopes", scope);
  }
  for (const candidate of observability.maintenanceCandidatePaths ?? []) {
    if (commandIncludesPath(command, candidate)) {
      addPath(observability, "observedMaintenanceCandidatePaths", candidate);
    }
  }
}

function observeLintPath(observability: JobRetrievalObservability, filePath: string) {
  const scope = (observability.partitionScopes ?? []).find((value) => pathIsInScope(filePath, value));
  if (scope) addPath(observability, "observedPartitionScopes", scope);
  const candidate = (observability.maintenanceCandidatePaths ?? [])
    .find((value) => pathsMatch(filePath, value));
  if (candidate) addPath(observability, "observedMaintenanceCandidatePaths", candidate);
}

function refreshDerivedFields(value: JobRetrievalObservability) {
  if (value.mode === "candidates") {
    value.candidateCoverage = coverage(
      value.candidatePaths ?? [],
      value.openedCandidatePaths ?? [],
      value.searchedCandidatePaths ?? [],
    );
    delete value.partitionCoverage;
  } else {
    const offered = value.partitionScopes ?? [];
    const observed = new Set(value.observedPartitionScopes ?? []);
    value.partitionCoverage = {
      offered: offered.length,
      observed: observed.size,
      untouched: offered.filter((scope) => !observed.has(scope)).length,
    };
    delete value.candidateCoverage;
  }
  const signals: JobRetrievalObservability["policySignals"] = [];
  if (value.broadRootSearchCount > 0) signals.push("broad_root_search");
  if (value.broadExcludedPathAccessCount > 0) signals.push("excluded_path_access");
  if (signals.length > 0) value.policySignals = signals;
  else delete value.policySignals;
}

function coverage(offered: string[], opened: string[], searched: string[]): JobRetrievalCoverage {
  const touched = new Set([...opened, ...searched]);
  const used = offered.filter((value) => touched.has(value)).length;
  return {
    offered: offered.length,
    opened: opened.length,
    searched: searched.length,
    used,
    untouched: offered.length - used,
    useRatio: offered.length > 0 ? used / offered.length : null,
  };
}

function isCompletedCommandEvent(event: unknown) {
  if (!isRecord(event)) return false;
  if (event.tool === "shell_command") return true;
  const markers: string[] = [];
  visit(event, (value, key) => {
    if ((key === "type" || key === "method") && typeof value === "string") markers.push(value);
  });
  return markers.some((marker) => /(?:^|[./])item[./](?:completed|commandExecution\/completed)$/i.test(marker)) ||
    markers.some((marker) => /^item\.completed$/i.test(marker));
}

function extractCommandStrings(event: unknown) {
  const commands: string[] = [];
  visit(event, (value, key) => {
    if (!/^(command|cmd|script)$/i.test(key) || typeof value !== "string") return;
    if (!value || value.length > MAX_COMMAND_LENGTH || commands.includes(value)) return;
    commands.push(value);
  });
  return commands;
}

function largestOutputString(event: unknown) {
  let largest = 0;
  visit(event, (value, key) => {
    if (!/^(output|aggregatedOutput|aggregated_output)$/i.test(key) || typeof value !== "string") return;
    largest = Math.max(largest, value.length);
  });
  return largest;
}

function isSearchCommand(command: string) {
  return /\b(rg|grep|findstr|Select-String)\b/i.test(command) || /\bgit\s+grep\b/i.test(command) ||
    /\bGet-ChildItem\b[^\r\n]*\b-Recurse\b/i.test(command);
}

function isOpenCommand(command: string) {
  return /\b(Get-Content|gc|type|cat|head|tail)\b/i.test(command) || /\bgit\s+(show|blame)\b/i.test(command);
}

function isBroadRootSearch(command: string) {
  if (!isSearchCommand(command)) return false;
  const normalized = command.replaceAll("\\", "/");
  if (/\b(rg|grep)\b[^\r\n]*(?:^|\s)\.(?:\s|$)/i.test(normalized)) return true;
  if (/\b(rg|grep)\b[^\r\n]*--hidden\b/i.test(normalized)) return true;
  if (/\brg\b[^\r\n]*--files(?:\s|$)/i.test(normalized) && !/\b(?:wiki|index\.md)\b/i.test(normalized)) return true;
  if (/\bGet-ChildItem\b[^\r\n]*\b-Recurse\b/i.test(normalized) && !/\b(?:wiki|index\.md)\b/i.test(normalized)) return true;
  return false;
}

function isExcludedPath(value: string) {
  const normalized = normalizePath(value);
  return normalized === "log.md" || normalized.endsWith("/log.md") ||
    normalized === "raw" || normalized.startsWith("raw/") || normalized.includes("/raw/") ||
    normalized === "assets" || normalized.includes("/assets/");
}

function excludedPathsInCommand(command: string) {
  const paths: string[] = [];
  const normalized = command.replaceAll("\\", "/");
  for (const match of normalized.matchAll(/(?:^|[\s'"`(])((?:[^\s'"`();]+\/)*(?:log\.md|raw(?:\/[^\s'"`();]+)?|assets(?:\/[^\s'"`();]+)?))/gi)) {
    const candidate = match[1];
    if (!candidate || !isExcludedPath(candidate)) continue;
    paths.push(candidate);
  }
  return normalizePaths(paths);
}

function knownObservedReadPaths(value: JobRetrievalObservability) {
  return normalizePaths([
    ...(value.openedCandidatePaths ?? []),
    ...(value.otherObservedReadPaths ?? []),
    ...(value.excludedPathAccesses ?? []),
  ]);
}

function isBroadExcludedPathAccess(
  command: string,
  excludedPaths: string[],
  open: boolean,
  search: boolean,
) {
  if ((!open && !search) || excludedPaths.length === 0) return false;
  const normalized = command.replaceAll("\\", "/");
  if (/[*?]/.test(normalized)) return true;
  if (/\bGet-ChildItem\b[^\r\n]*\b-Recurse\b/i.test(normalized)) return true;
  if (excludedPaths.some(isExcludedDirectoryPath)) return true;
  if (open && excludedPaths.some(isLogPath) &&
      !/(?:-Tail|-TotalCount|-First)\b|\bSelect-Object\b[^\r\n]*-First\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function isTargetedProvenanceAccess(excludedPaths: string[], isRead: boolean) {
  return isRead && excludedPaths.some((candidate) => {
    const normalized = normalizePath(candidate);
    return (normalized.startsWith("raw/") || normalized.includes("/raw/")) &&
      !isExcludedDirectoryPath(normalized) && !/[*?]/.test(normalized);
  });
}

function isExcludedDirectoryPath(value: string) {
  const normalized = normalizePath(value);
  if (normalized === "raw" || normalized.endsWith("/raw") ||
      normalized === "assets" || normalized.endsWith("/assets")) return true;
  const inExcludedTree = normalized.startsWith("raw/") || normalized.includes("/raw/") ||
    normalized.startsWith("assets/") || normalized.includes("/assets/");
  return inExcludedTree && path.posix.extname(normalized) === "";
}

function isLogPath(value: string) {
  const normalized = normalizePath(value);
  return normalized === "log.md" || normalized.endsWith("/log.md");
}

function isWikiKnowledgePath(value: string) {
  const normalized = normalizePath(value);
  return normalized === "index.md" || normalized.startsWith("wiki/") || normalized.includes("/wiki/");
}

function commandIncludesPath(command: string, candidate: string) {
  const normalizedCommand = command.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const normalizedCandidate = normalizePath(candidate);
  return normalizedCandidate.length > 0 && normalizedCommand.includes(normalizedCandidate);
}

function pathsMatch(observed: string, candidate: string) {
  const normalizedObserved = normalizePath(observed);
  const normalizedCandidate = normalizePath(candidate);
  return normalizedObserved === normalizedCandidate || normalizedObserved.endsWith(`/${normalizedCandidate}`);
}

function pathIsInScope(observed: string, scope: string) {
  const normalizedObserved = normalizePath(observed);
  const normalizedScope = normalizePath(scope);
  return normalizedObserved === normalizedScope || normalizedObserved.startsWith(`${normalizedScope}/`) ||
    normalizedObserved.includes(`/${normalizedScope}/`);
}

function normalizePath(value: string) {
  return value.trim().replace(/^['"`]+|['"`,;:]+$/g, "").replaceAll("\\", "/")
    .replace(/^\.\//, "").replace(/\/$/, "").toLocaleLowerCase("en-US");
}

function normalizePaths(values: string[]) {
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePath(value);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= MAX_PATHS) break;
  }
  return result;
}

function addPath<K extends keyof JobRetrievalObservability>(
  value: JobRetrievalObservability,
  key: K,
  candidate: string,
) {
  const current = value[key];
  if (current !== undefined && !Array.isArray(current)) return;
  const paths = (current ?? []) as string[];
  const normalized = normalizePath(candidate);
  if (!normalized || paths.includes(normalized) || paths.length >= MAX_PATHS) return;
  paths.push(normalized);
  (value as unknown as Record<string, unknown>)[key] = paths;
}

function copyPaths(
  source: Record<string, unknown>,
  target: JobRetrievalObservability,
  key: keyof JobRetrievalObservability,
) {
  const value = source[key];
  if (!Array.isArray(value)) return;
  const paths = normalizePaths(stringArray(value));
  if (paths.length > 0) (target as unknown as Record<string, unknown>)[key] = paths;
}

function visit(root: unknown, visitor: (value: unknown, key: string) => void) {
  const stack: Array<{ value: unknown; key: string; depth: number }> = [
    { value: root, key: "", depth: 0 },
  ];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_EVENT_NODES) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    visitor(current.value, current.key);
    if (current.depth >= MAX_EVENT_DEPTH || !current.value || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      const items = current.value.slice(0, MAX_ARRAY_ITEMS);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        stack.push({ value: items[index], key: current.key, depth: current.depth + 1 });
      }
    } else {
      for (const [key, value] of Object.entries(current.value).reverse()) {
        stack.push({ value, key, depth: current.depth + 1 });
      }
    }
  }
}

function stringArray(value: unknown[]) {
  return value.filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length <= 128 ? value : undefined;
}

function jobCommandValue(value: unknown): JobCommand | undefined {
  return value === "query" || value === "ingest" || value === "lint" ? value : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function optionalNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
