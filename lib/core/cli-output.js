import { cliLanguage } from "./cli-help.js";
import { errorText, messageText } from "./cli-messages.js";

function output(env) {
  const lines = [];
  const t = (english, korean) => cliLanguage(env) === "ko" ? korean : english;
  const add = (line) => { if (line) lines.push(line); };
  const note = (value) => { if (value) add(messageText(value, env)); };
  const error = (label, value) => { if (value) add(`${label}: ${errorText(value, env)}`); };
  return { lines, t, add, note, error, text: () => lines.join("\n") };
}

export function formatClaudeResult(result, { removing = false, env = process.env } = {}) {
  const o = output(env);
  const state = result.error ? "error" : result.skipped ? "unchanged"
    : removing ? result.changed ? result.restored ? "restored" : "removed" : "unchanged" : "ready";
  o.add(`Claude statusLine: ${state}${result.settingsPath ? ` · ${result.settingsPath}` : ""}`);
  if (result.error) o.error("Error", result.error);
  else if (result.skipped || (removing && !result.changed)) o.note(result.reason);
  if (result.backedUp) o.add(o.t("Previous statusLine saved for restore.", "이전 statusLine을 복구용으로 저장했습니다."));
  return o.text();
}

export function formatSetupResult(result, { failed = false, platform = process.platform, reloadCommand, restartNote, env = process.env } = {}) {
  const o = output(env);
  const { codex, claude, tmux } = result;
  if (claude) {
    o.add(formatClaudeResult(claude, { env }));
    if (!claude.skipped && !claude.error) o.add(o.t("Restart Claude Code to apply.", "Claude Code를 다시 실행하면 적용됩니다."));
    if (claude.launcher?.error) o.error("Claude launcher", claude.launcher.error);
    else if (claude.launcher?.ok === false) o.note(claude.launcher.reason);
  }
  if (codex) {
    if (codex.standalone) {
      o.add("Codex: standalone");
    } else if (codex.ok) {
      o.add(`Codex wrapper: ready · ${codex.wrapperPath}`);
      o.add(`Original: ${codex.originalCommand}`);
      if (reloadCommand) o.add(`${o.t("Apply", "적용")}: ${reloadCommand}`);
      else if (platform === "win32") o.add(o.t("Open a new cmd/PowerShell to apply PATH changes.", "PATH 변경을 적용하려면 새 cmd/PowerShell을 여세요."));
      else if (codex.newlyInstalled) o.add(o.t("Apply in existing shells: hash -r (zsh: rehash).", "기존 셸에 적용: hash -r (zsh: rehash)."));
      if (codex.path?.ok === false || codex.path?.error) {
        o.error("PATH", codex.path.error || o.t("Could not update PATH.", "PATH를 갱신하지 못했습니다."));
      }
      if (/^(Could not|Skipped)/.test(codex.path?.note || "")) o.note(codex.path.note);
    } else {
      o.add("Codex: skipped");
      o.note(codex.reason);
    }
    if (codex.standalone && platform !== "win32" && !tmux) o.add(o.t("Terminal usage: ai-battery setup tmux", "터미널 사용량 표시: ai-battery setup tmux"));
    if (codex.statusLine) {
      const status = codex.statusLine;
      o.add(`Codex status_line: ${status.error ? "error" : status.alreadyConfigured ? "already configured" : "configured"} · ${status.configPath}`);
      o.error("Error", status.error);
    }
    if (codex.retainedConfig) o.add(o.t("Codex recovery record preserved; restore is incomplete.", "Codex 복원이 끝나지 않아 복구 기록을 유지했습니다."));
  }
  if (tmux) {
    o.add(`tmux status-right: ${tmux.ok ? tmux.active ? "active" : "configured" : tmux.skipped ? "skipped" : "error"}${tmux.confPath ? ` · ${tmux.confPath}` : ""}`);
    if (tmux.error) o.error("Error", tmux.error);
    else if (!tmux.ok) o.note(tmux.reason);
    else if (!tmux.active) o.add(o.t("Start: tmux", "실행: tmux"));
  }
  const rowpty = codex?.rowpty;
  if (rowpty && !rowpty.skipped) {
    o.add(`rowpty: ${rowpty.error || rowpty.ok === false ? "error" : "ready"}${rowpty.exePath ? ` · ${rowpty.exePath}` : ""}`);
    o.error("Error", rowpty.error);
    if (rowpty.ok === false && !rowpty.error) o.note(rowpty.reason);
    if (rowpty.error) o.add(o.t("Using overlay until rowpty is available.", "rowpty를 사용할 수 있을 때까지 overlay로 표시합니다."));
  }
  o.add(o.t(failed ? "Setup incomplete. Run: ai-battery doctor" : "Setup complete.", failed ? "설정 미완료. 확인: ai-battery doctor" : "설정 완료."));
  o.add(`${o.t("Restore", "설정 복원")}: ai-battery reset`);
  o.note(restartNote);
  return o.text();
}

export function formatDoctorResult(result, { env = process.env } = {}) {
  const o = output(env);
  const { aiBattery: battery, codex, claude } = result;
  o.add(`AI Battery ${battery.version}`);
  if (battery.latestVersion) {
    o.add(`Update: ${battery.updateAvailable ? `${battery.version} → ${battery.latestVersion}` : battery.version !== battery.latestVersion ? "local build" : "up to date"}`);
    if (battery.updateAvailable) o.add(`${o.t("Install", "업데이트")}: npm install -g ${battery.packageName}@latest`);
  } else {
    o.add(`Update: ${battery.updateCheck.error === "disabled" ? "skipped" : "unavailable"}`);
    if (battery.updateCheck.error !== "disabled") o.error("npm", battery.updateCheck.error);
  }
  o.lines.push("");
  o.add(`Codex: ${codex.providerEnabled ? "on" : "off"} · ${codex.activeIsWrapper ? "wrapper" : "standalone"}`);
  o.add(`  Command: ${codex.activeCodex || "not found"}`);
  o.add(`  status_line: ${codex.statusLine.error ? "error" : codex.statusLine.configured ? "configured" : "optional"}`);
  o.error("  Error", codex.statusLine.error);
  o.add(`  Logs: ${codex.sessionsExists ? "ready" : "not found"}`);
  o.add(`  Runner: ${codex.runnerExists ? "ready" : "not found"}`);
  if (codex.wrapperInstalled && !codex.activeIsWrapper) o.add(`  Wrapper: ${codex.wrapperPath}`);
  if (codex.compositor) o.add(`  Compositor: ${codex.compositor.available ? "ready" : "dependencies missing"}`);
  if (codex.rowpty?.layoutRequested) o.add(`  rowpty: ${codex.rowpty.installed ? "ready" : "not found"} · ConPTY: ${codex.rowpty.bundledConpty ? "bundled" : "OS"}`);
  o.lines.push("");
  o.add(`Claude: ${claude.providerEnabled ? "on" : "off"}`);
  o.add(`  statusLine: ${claude.statusLine.error ? "error" : claude.statusLine.managed ? "ready" : claude.statusLine.configured ? "external" : "not configured"}`);
  o.add(`  Cache: ${claude.statuslineCache ? "ready" : "waiting"}`);
  if (claude.statusLine.managed && !claude.statuslineCache) o.add(o.t("  Start Claude Code to receive usage data.", "  Claude Code를 실행하면 사용량이 수집됩니다."));
  if (result.tmux) {
    o.lines.push("");
    o.add(`tmux: ${result.tmux.error ? "error" : result.tmux.configured ? result.tmux.insideTmux ? "configured · in session" : "configured · outside session" : "not configured"}`);
    o.error("  Error", result.tmux.error);
    if (result.tmux.configured && !result.tmux.insideTmux) o.add(o.t("  Start: tmux", "  실행: tmux"));
    else if (!result.tmux.configured && !codex.wrapperInstalled) o.add(o.t("  Terminal usage: ai-battery setup tmux", "  터미널 사용량 표시: ai-battery setup tmux"));
  }
  const recovery = battery.recovery;
  const backups = [recovery.codexWrapper && "Codex wrapper", recovery.codexStatusLine && "Codex status_line", recovery.claudeStatusLine && "Claude statusLine"].filter(Boolean);
  if (backups.length) o.add(`Recovery: ${backups.join(", ")}`);
  const notes = [...codex.notes, ...claude.notes].filter((note) =>
    ![
      "Codex wrapper is not installed. Run: ai-battery setup codex",
      "Codex status_line is not configured. Run: ai-battery setup codex"
    ].includes(note) && (codex.wrapperInstalled || !note.startsWith("Current Codex was not started through AI Battery."))
  );
  if (notes.length) {
    o.lines.push("");
    for (const note of [...new Set(notes)]) o.add(`- ${errorText(note, env)}`);
  }
  o.lines.push("");
  o.add(`${o.t("Details", "상세 진단")}: ai-battery doctor --json`);
  return o.text();
}

export function formatResetResult(result, { failed = false, wrapped = false, platform = process.platform, env = process.env } = {}) {
  const o = output(env);
  const { codex, claude, hud, artifacts } = result.results;
  if (codex) {
    const restored = codex.restoredWrappers || [];
    const removed = codex.removedWrappers || [];
    o.add(`Codex wrapper: ${codex.error ? "error" : restored.length ? "restored" : removed.length ? "removed" : "unchanged"}`);
    o.error("Error", codex.error);
    for (const item of restored) o.add(`  ${item.wrapperPath} ← ${item.restoredFrom}`);
    for (const file of removed) o.add(`  ${file}`);
    for (const item of codex.skippedWrappers || []) { o.add(`  Preserved: ${item.wrapperPath}`); o.note(item.reason); }
    if (codex.retainedConfig) o.note(codex.reason);
    for (const file of codex.unmanaged || []) o.add(`  Preserved: ${file}`);
    for (const file of codex.rcPaths || []) o.add(`PATH: restored · ${file}`);
    if (codex.statusLine) {
      const status = codex.statusLine;
      o.add(`Codex status_line: ${status.error ? "error" : status.restored ? "restored" : status.removed ? "removed" : "unchanged"}`);
      if (status.error) o.error("Error", status.error);
      else if (status.skipped) o.note(status.reason);
    }
  }
  if (claude) o.add(formatClaudeResult(claude, { removing: true, env }));
  if (hud) {
    if (hud.error) o.error("HUD", hud.error);
    else if (hud.skipped) o.add("HUD: skipped");
    else {
      o.add(`HUD: ${hud.stop.ok ? "stopped" : "stop failed"} · Autostart: ${hud.autostart.ok ? "off" : "cleanup failed"}`);
      for (const item of [hud.stop, hud.autostart, hud.gnome].filter(Boolean)) {
        o.error("HUD", item.error);
        o.error("HUD", item.stderr);
      }
    }
  }
  for (const [name, item] of Object.entries(result.results)) {
    if (["codex", "claude", "hud", "artifacts"].includes(name)) continue;
    if (!item.error && !item.errors?.length && item.changed) o.add(`${name}: restored`);
    o.error(name, item.error);
    for (const error of item.errors || []) o.error(`${name} · ${error.path}`, error.error);
    for (const file of item.paths || []) o.add(`Recovery pending: ${file}`);
  }
  if (artifacts) {
    o.add(`Files: removed ${artifacts.removed.length} · preserved ${artifacts.retained.length}`);
    for (const file of artifacts.retained) o.add(`  Preserved: ${file}`);
    for (const error of artifacts.errors) o.error(`Cleanup · ${error.path}`, error.error);
  }
  if (wrapped && result.targets.includes("codex")) o.add(o.t("Exit this Codex session to remove its terminal row.", "이 Codex 세션을 종료하면 하단 상태줄이 사라집니다."));
  o.add(o.t(failed ? "Reset incomplete. Recovery records and npm package preserved." : "Settings restored. npm package unchanged.", failed ? "복원 미완료. 복구 기록과 npm 패키지를 유지했습니다." : "복원 완료. npm 패키지는 유지됩니다."));
  if (!failed) o.add(`${o.t("Remove package", "패키지 삭제")}: npm uninstall -g ai-battery`);
  if (platform !== "win32" && codex?.changed) o.add(o.t("Refresh this terminal: hash -r (zsh: rehash).", "현재 터미널에 적용: hash -r (zsh: rehash)."));
  return o.text();
}

export function formatVisibilityResult(result, { restartNote, env = process.env } = {}) {
  const text = `${result.providers.join(", ")}: ${result.visible ? "on" : "off"}`;
  return restartNote ? `${text}\n${messageText(restartNote, env)}` : text;
}
