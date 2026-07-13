import { spawnSync } from "node:child_process";

type VersionCommandResult = {
  status: number | null;
  stdout?: string | Buffer;
};

type VersionCommand = (codexBin: string) => VersionCommandResult;

export function resolveCodexVersion(
  codexBin: string,
  runVersionCommand: VersionCommand = defaultVersionCommand,
): string | undefined {
  try {
    const result = runVersionCommand(codexBin);
    if (result.status !== 0) return undefined;
    const version = result.stdout?.toString().trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

function defaultVersionCommand(codexBin: string): VersionCommandResult {
  return spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32" && !codexBin.toLowerCase().endsWith(".exe"),
    windowsHide: true,
  });
}
