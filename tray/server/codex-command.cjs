function resolveCodexCommand(env = process.env) {
  const configured = env.CODEX_BIN?.trim();
  return configured || "codex";
}

module.exports = { resolveCodexCommand };
