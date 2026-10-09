// Shared PATH lookup and command launch for Windows. Generated bridges embed
// this file so a removed AI Battery package cannot pin Codex to an old install.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const UNSAFE_CMD_ARGUMENT_RE = /[\r\n&|<>^%!()]/;
const UNSAFE_CMD_PATH_RE = /[\r\n&|<>^%!]/;

function windowsCommandNames(command, env = process.env) {
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...extensions.map((ext) => command + ext.toLowerCase()), command];
}

function isManagedWrapper(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(512);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    return header.toString("utf8", 0, count).includes("AI_BATTERY_MANAGED_CODEX_WRAPPER");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findWindowsPathCommand(command, env = process.env, skipPaths = []) {
  for (const entry of (env.PATH || "").split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    for (const name of windowsCommandNames(command, env)) {
      const candidate = path.resolve(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (skipPaths.some((entry) => {
          try {
            return fs.realpathSync(candidate).toLowerCase() === fs.realpathSync(entry).toLowerCase();
          } catch {
            return path.resolve(candidate).toLowerCase() === path.resolve(entry).toLowerCase();
          }
        })) continue;
        if (command === "codex" && isManagedWrapper(candidate)) continue;
        return candidate;
      } catch {}
    }
  }
  return null;
}

function normalizeWindowsCommandPath(value) {
  let text = String(value || "").trim();
  for (let i = 0; i < 6; i += 1) {
    const before = text;
    text = text.replace(/\\"/g, "\"").trim();
    if (
      (text.startsWith("\"") && text.endsWith("\""))
      || (text.startsWith("'") && text.endsWith("'"))
    ) {
      text = text.slice(1, -1).trim();
    }
    if (text === before) break;
  }
  return text;
}

function resolveWindowsCommandFile(commandPath) {
  commandPath = normalizeWindowsCommandPath(commandPath);
  if (path.extname(commandPath)) return commandPath;
  for (const suffix of [".cmd", ".exe", ".bat", ".ps1"]) {
    const candidate = `${commandPath}${suffix}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return commandPath;
}

function resolveNpmCmdShim(commandPath) {
  if (!/\.cmd$/i.test(commandPath)) return null;
  let source;
  try {
    source = fs.readFileSync(commandPath, "utf8");
  } catch {
    return null;
  }
  if (!source.includes("%dp0%") || !source.includes("%*")) return null;
  const match = source.match(/%dp0%[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"?\s+%\*/i);
  if (!match) return null;
  const scriptPath = path.resolve(path.dirname(commandPath), match[1].replace(/[\\/]+/g, path.sep));
  if (!fs.existsSync(scriptPath)) return null;
  const localNode = path.join(path.dirname(commandPath), "node.exe");
  return {
    // npm uses its adjacent node.exe, otherwise the caller's PATH Node.
    file: fs.existsSync(localNode) ? localNode : findWindowsPathCommand("node") || "node",
    scriptPath
  };
}

function assertSafeCmdArguments(commandPath, args) {
  const unsafePath = UNSAFE_CMD_PATH_RE.test(String(commandPath));
  const unsafeArgument = args.find((value) => UNSAFE_CMD_ARGUMENT_RE.test(String(value)));
  if (!unsafePath && unsafeArgument === undefined) return;
  throw new Error(
    `Cannot safely pass shell metacharacters through legacy batch command ${commandPath}. `
    + "Use an .exe/.js entrypoint or an npm-generated .cmd shim instead."
  );
}

function windowsCommand(command) {
  const exe = resolveWindowsCommandFile(command[0]);
  const rest = command.slice(1);
  if (/\.(cmd|bat)$/i.test(exe)) {
    const npmShim = resolveNpmCmdShim(exe);
    if (npmShim) {
      return {
        file: npmShim.file,
        args: [npmShim.scriptPath, ...rest]
      };
    }
    assertSafeCmdArguments(exe, rest);
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "call", exe, ...rest]
    };
  }
  if (/\.ps1$/i.test(exe)) {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, ...rest]
    };
  }
  if (/\.(js|mjs|cjs)$/i.test(exe)) {
    return {
      file: process.execPath,
      args: [exe, ...rest]
    };
  }
  return { file: exe, args: rest };
}

async function runCodexWrapper(runner) {
  const command = findWindowsPathCommand("codex");
  if (!command) {
    console.error("codex: command not found on PATH");
    process.exitCode = 127;
    return;
  }
  const env = { ...process.env, AI_BATTERY_ORIGINAL_CODEX: command };
  delete env.AI_BATTERY_WRAPPED_CODEX;
  let launch;
  if (process.stdin.isTTY && process.stdout.isTTY
    && env.AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER !== "1" && fs.existsSync(runner)) {
    env.AI_BATTERY_WRAPPED_CODEX = "1";
    launch = { file: process.execPath, args: [runner, "--provider", "all", "--left-padding", "2", "--", command, ...process.argv.slice(2)] };
  } else {
    launch = windowsCommand([command, ...process.argv.slice(2)]);
  }
  const child = spawn(launch.file, launch.args, { stdio: "inherit", env });
  child.on("error", (error) => {
    console.error("codex: " + error.message);
    process.exitCode = error.code === "ENOENT" ? 127 : 1;
  });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}

module.exports = {
  findWindowsPathCommand, windowsCommandNames, runCodexWrapper,
  normalizeWindowsCommandPath, resolveWindowsCommandFile, resolveNpmCmdShim, windowsCommand
};
