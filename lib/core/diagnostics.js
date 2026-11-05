// Installation readiness is independent of the on/off visibility preference.
// These states describe the next command; an existing session is separate.
export function codexTerminalDisplay(data, { platform = process.platform, layout = "" } = {}) {
  let status = "ready";
  let action = null;
  if (!data.wrapperInstalled) {
    status = "not configured";
    action = "ai-battery setup codex";
  } else if (!data.activeIsWrapper) {
    status = "PATH mismatch";
    action = platform === "win32" ? "Open a new terminal to apply PATH changes."
      : "Load the shell configuration or open a new terminal, then run hash -r (zsh: rehash).";
  } else if (!data.runnerExists) {
    status = "runner missing";
    action = "npm install -g ai-battery@latest";
  } else if (platform !== "win32" && !data.python3) {
    status = "python3 missing";
    action = "Install Python 3, then run codex again.";
  } else if (!(data.followsPath ? data.resolvedOriginalCommand : data.originalExists)) {
    status = "Codex missing";
    action = "Install Codex or restore its original command on PATH, then run ai-battery setup codex.";
  } else if (platform === "win32" && layout === "plain") {
    status = "disabled by layout";
    action = "Set AI_BATTERY_WIN_LAYOUT=composite, then run codex again.";
  }
  return {
    status,
    ready: status === "ready",
    action,
    currentSession: !data.insideCodex ? "not checked" : data.currentCodexWrapped ? "wrapped" : "unwrapped"
  };
}

export function claudeTerminalDisplay(statusLine, hasReading) {
  const status = statusLine.error ? "settings error" : !statusLine.configured ? "not configured"
    : !statusLine.managed ? "external statusLine" : statusLine.needsRefresh ? "update required"
      : hasReading ? "ready" : "waiting for data";
  return {
    status,
    ready: ["ready", "waiting for data"].includes(status),
    action: status === "not configured" || status === "update required" ? "ai-battery setup claude"
      : status === "external statusLine" ? "ai-battery setup claude --force"
        : status === "waiting for data" ? "Start Claude Code to receive usage data." : null
  };
}
