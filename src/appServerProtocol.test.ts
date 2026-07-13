import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_SERVER_SANDBOX_DANGER_FULL_ACCESS,
  APP_SERVER_SANDBOX_READ_ONLY,
} from "./appServerRunner.js";

const codexBin = process.env.CODEX_BIN ?? defaultCodexBin();
const codexAvailable = canRunCodex(codexBin);

test(
  "installed app-server protocol exposes the wire surface used by wiki-server",
  { skip: codexAvailable ? false : `codex binary not runnable: ${codexBin}` },
  () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-app-protocol-"));
    try {
      const result = spawnSync(
        codexBin,
        ["app-server", "generate-ts", "--experimental", "--out", outputDir],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );

      assert.equal(
        result.status,
        0,
        `codex app-server generate-ts failed: ${result.stderr || result.stdout}`,
      );

      const generated = {
        sandboxMode: readGenerated(outputDir, "SandboxMode.ts"),
        threadStart: readGenerated(outputDir, "ThreadStartParams.ts"),
        turnStart: readGenerated(outputDir, "TurnStartParams.ts"),
        userInput: readGenerated(outputDir, "UserInput.ts"),
        turnCompleted: readGenerated(outputDir, "TurnCompletedNotification.ts"),
        agentDelta: readGenerated(outputDir, "AgentMessageDeltaNotification.ts"),
        itemCompleted: readGenerated(outputDir, "ItemCompletedNotification.ts"),
        threadItem: readGenerated(outputDir, "ThreadItem.ts"),
        commandApproval: readGenerated(outputDir, "CommandExecutionRequestApprovalResponse.ts"),
        fileApproval: readGenerated(outputDir, "FileChangeRequestApprovalResponse.ts"),
        toolInput: readGenerated(outputDir, "ToolRequestUserInputResponse.ts"),
        elicitation: readGenerated(outputDir, "McpServerElicitationRequestResponse.ts"),
        permissionsRequest: readGenerated(outputDir, "PermissionsRequestApprovalParams.ts"),
        permissionsResponse: readGenerated(outputDir, "PermissionsRequestApprovalResponse.ts"),
      };

      assertGeneratedContains(generated.sandboxMode, [
        JSON.stringify(APP_SERVER_SANDBOX_READ_ONLY),
        JSON.stringify(APP_SERVER_SANDBOX_DANGER_FULL_ACCESS),
      ]);
      assertGeneratedContains(generated.threadStart, [
        "model?: string | null",
        "serviceTier?: string | null | null",
        "approvalPolicy?: AskForApproval | null",
        "sandbox?: SandboxMode | null",
        "config?: { [key in string]?: JsonValue } | null",
        "serviceName?: string | null",
        "ephemeral?: boolean | null",
        "experimentalRawEvents: boolean",
        "persistExtendedHistory: boolean",
      ]);
      assertGeneratedContains(generated.turnStart, [
        "threadId: string",
        "input: Array<UserInput>",
      ]);
      assertGeneratedContains(generated.userInput, [
        '{ "type": "text", text: string',
        "text_elements: Array<TextElement>",
      ]);
      assertGeneratedContains(generated.turnCompleted, [
        "threadId: string",
        "turn: Turn",
      ]);
      assertGeneratedContains(generated.agentDelta, [
        "threadId: string",
        "turnId: string",
        "delta: string",
      ]);
      assertGeneratedContains(generated.itemCompleted, [
        "item: ThreadItem",
        "threadId: string",
        "turnId: string",
      ]);
      assertGeneratedContains(generated.threadItem, [
        '{ "type": "agentMessage"',
        "text: string",
      ]);
      assertGeneratedContains(generated.commandApproval, [
        "decision: CommandExecutionApprovalDecision",
      ]);
      assertGeneratedContains(generated.fileApproval, [
        "decision: FileChangeApprovalDecision",
      ]);
      assertGeneratedContains(generated.toolInput, [
        "answers: { [key in string]?: ToolRequestUserInputAnswer }",
      ]);
      assertGeneratedContains(generated.elicitation, [
        "action: McpServerElicitationAction",
        "content: JsonValue | null",
      ]);
      assertGeneratedContains(generated.permissionsRequest, [
        "permissions: RequestPermissionProfile",
      ]);
      assertGeneratedContains(generated.permissionsResponse, [
        "permissions: GrantedPermissionProfile",
        "scope: PermissionGrantScope",
      ]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  },
);

function defaultCodexBin() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe");
  }

  return "codex";
}

function canRunCodex(command: string) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function readGenerated(outputDir: string, fileName: string) {
  return readFileSync(path.join(outputDir, "v2", fileName), "utf8");
}

function assertGeneratedContains(source: string, snippets: string[]) {
  for (const snippet of snippets) {
    assert.match(source, new RegExp(escapeRegExp(snippet)));
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
