import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function installWikiRetrievalCommand(
  dataDir: string,
  baseUrl: string,
  token: string,
) {
  const toolDirectory = path.join(dataDir, "tools");
  mkdirSync(toolDirectory, { recursive: true });
  const scriptPath = path.join(toolDirectory, "wiki-retrieval.ps1");
  const commandPath = path.join(toolDirectory, "wiki-retrieval.cmd");
  writeFileSync(scriptPath, renderPowerShellClient(baseUrl, token), "utf8");
  writeFileSync(
    commandPath,
    `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" %*\r\n`,
    "utf8",
  );
  return toolDirectory;
}

function renderPowerShellClient(baseUrl: string, token: string) {
  const endpoint = escapePowerShellLiteral(baseUrl.replace(/\/$/, ""));
  const secret = escapePowerShellLiteral(token);
  return `param(
  [Parameter(Position=0, Mandatory=$true)][string]$Operation,
  [Parameter(Position=1, ValueFromRemainingArguments=$true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$headers = @{ 'x-wiki-retrieval-token' = '${secret}' }
$baseUrl = '${endpoint}'

try {
  if ($Operation -eq 'search') {
    if ($Rest.Count -lt 1) { throw 'usage: wiki-retrieval search "query" [query|ingest] [maxCandidates]' }
    $command = if ($Rest.Count -ge 2) { $Rest[1] } else { 'query' }
    $body = @{ query = $Rest[0]; command = $command }
    if ($Rest.Count -ge 3) { $body.maxCandidates = [int]$Rest[2] }
    $uri = "$baseUrl/_internal/retrieval/search"
  } elseif ($Operation -eq 'read') {
    if ($Rest.Count -lt 1) { throw 'usage: wiki-retrieval read "wiki/path.md" [heading "Title" | lines START END | full]' }
    $body = @{ path = $Rest[0] }
    $mode = if ($Rest.Count -ge 2) { $Rest[1] } else { 'lines' }
    if ($mode -eq 'heading') {
      if ($Rest.Count -lt 3) { throw 'heading mode requires a heading title' }
      $body.heading = $Rest[2]
    } elseif ($mode -eq 'lines') {
      $body.startLine = if ($Rest.Count -ge 3) { [int]$Rest[2] } else { 1 }
      $body.endLine = if ($Rest.Count -ge 4) { [int]$Rest[3] } else { $body.startLine + 199 }
    } elseif ($mode -eq 'full') {
      $body.full = $true
    } else {
      throw 'read mode must be heading, lines, or full'
    }
    $uri = "$baseUrl/_internal/retrieval/read"
  } else {
    throw 'operation must be search or read'
  }

  $json = $body | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $json
  $result | ConvertTo-Json -Depth 12 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
}

function escapePowerShellLiteral(value: string) {
  return value.replaceAll("'", "''");
}
