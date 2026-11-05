// Follow the same locale order as Tidy; untranslated languages use English.
export function cliLanguage(env = process.env, defaultLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const languages = env.LANGUAGE?.trim()
    ? env.LANGUAGE.split(":")
    : [env.LC_ALL || env.LC_MESSAGES || env.LANG || defaultLocale];
  for (const language of languages) {
    const base = language.trim().toLowerCase().split(/[_@.\-]/)[0];
    if (base === "ko") return "ko";
    if (["en", "c", "posix"].includes(base)) return "en";
  }
  return "en";
}

export function cliText(english, korean) {
  return cliLanguage() === "ko" ? korean : english;
}

export function cliError(english, korean, command = "") {
  const help = `ai-battery${command ? ` ${command}` : ""} --help`;
  return new Error(`${cliText(english, korean)} ${cliText(`Run ${help}.`, `${help}를 실행하세요.`)}`);
}

export function invalidChoice(option, choices, command = "") {
  const label = option === "target" ? "대상" : option;
  return cliError(`${option} must be one of: ${choices}.`, `${label} 값은 ${choices} 중에서 선택하세요.`, command);
}

export function requiredValue(argv, index, command = "") {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw cliError(`${argv[index]} requires a value.`, `${argv[index]} 뒤에 값을 입력하세요.`, command);
  }
  return value;
}

export function helpText(command = "", { env = process.env, platform = process.platform } = {}) {
  const language = cliLanguage(env);
  const t = (english, korean) => language === "ko" ? korean : english;
  const rows = (items) => {
    const width = Math.max(...items.map(([label]) => label.length)) + 2;
    return items.map(([label, english, korean]) => `  ${label.padEnd(width)}${t(english, korean)}`).join("\n");
  };
  const usage = (syntax) => `${t("Usage", "사용법")}: ai-battery ${syntax.replace("[command]", t("[command]", "[명령]")).replace("[options]", t("[options]", "[옵션]"))}`;
  const options = (items) => `${t("Options", "옵션")}:\n${rows(items)}`;
  const examples = (lines) => `${t("Examples", "예시")}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
  const json = ["--json", "Print JSON", "JSON으로 출력"];
  const providers = ["-p, --provider all|codex|claude", "Provider to show (default: all)", "표시할 도구 (기본: all)"];
  const colorOptions = [
    ["--ansi", "Use ANSI colors", "ANSI 색상 사용"],
    ["--muted", "Use muted colors", "차분한 색상 사용"],
    ["--no-color", "Disable colors", "색상 끄기"]
  ];
  const barWidth = ["--bar-width N", "Battery bar width (default: 10)", "배터리 바 너비 (기본: 10)"];
  const leftPadding = ["--left-padding N", "Add N spaces on the left", "왼쪽 여백 N칸"];
  const showPaths = ["--show-paths", "Include source log paths", "원본 로그 경로 표시"];
  const displayOptions = [
    providers,
    ["-w, --watch [seconds]", "Refresh periodically (default: 10s)", "주기적으로 갱신 (기본: 10초)"],
    json,
    ...colorOptions,
    barWidth,
    ["--max-width N", "Limit output width to N columns", "출력 너비를 N칸으로 제한"],
    leftPadding,
    ["--active-provider codex|claude", "Highlight the active tool", "사용 중인 도구 강조"],
    showPaths,
    ["--tmux", "Use tmux status bar colors", "tmux 상태 표시줄 색상 사용"]
  ];
  const headerOptions = [
    ["--no-header", "Hide Claude's extra header", "Claude 추가 헤더 숨기기"],
    ["--usage-row", "Always show the usage row", "사용량 행 항상 표시"],
    ["--no-usage-row", "Hide the duplicate usage row", "중복 사용량 행 숨기기"]
  ];
  const resetNote = t(
    "Restores integrations and cleans generated files. The npm package stays installed.\nRemove the package: npm uninstall -g ai-battery",
    "연동 설정을 복원하고 생성 파일을 정리합니다. npm 패키지는 유지됩니다.\n패키지 삭제: npm uninstall -g ai-battery"
  );
  if (command === "watch") {
    return [usage("--watch [seconds] [options]"), t("Keep Codex and Claude Code usage visible in the terminal.", "터미널에서 Codex와 Claude Code 사용량을 계속 표시합니다."), options(displayOptions), examples(["ai-battery -w", "ai-battery -p codex -w 5"])].join("\n\n");
  }
  if (command === "setup" || command === "install-claude-statusline") {
    const legacy = command === "install-claude-statusline";
    return [
      usage(legacy ? `${command} [--force]` : "setup [codex|claude|tmux|all] [options]"),
      legacy ? t("Configure Claude Code's usage status line.", "Claude Code 상태 표시줄에 사용량을 연결합니다.")
        : t("Configure usage display integrations (default: codex and claude; tmux is opt-in).", "사용량 표시를 연동합니다. 기본 대상은 codex와 claude이며 tmux는 별도로 지정합니다."),
      options([
        ["--force", "Replace an existing Claude statusLine", "기존 Claude 상태 표시줄 교체"],
        ...(!legacy ? [
          ["--wrap-codex", "Route the codex command through AI Battery", "codex 명령에 AI Battery 연결"],
          ["--configure-codex-statusline", "Configure Codex's built-in status line", "Codex 내장 상태 표시줄 설정"]
        ] : []),
        json
      ]),
      legacy ? t("Restore settings: ai-battery reset claude", "설정 복원: ai-battery reset claude")
        : t("By default, Codex keeps its command, PATH and settings.\nRestore settings: ai-battery reset", "기본 Codex 설치는 실행 명령·PATH·설정을 유지합니다.\n설정 복원: ai-battery reset"),
      examples(legacy ? [`ai-battery ${command}`] : ["ai-battery setup claude", "ai-battery setup tmux"])
    ].join("\n\n");
  }
  if (command === "uninstall-claude-statusline") {
    return [usage(`${command} [--json]`), t("Remove AI Battery's Claude status line and restore the previous one.", "AI Battery의 Claude 상태 표시줄을 해제하고 이전 설정을 복원합니다."),
      options([json]), t("Also available as: ai-battery reset claude", "같은 작업: ai-battery reset claude")].join("\n\n");
  }
  if (["reset", "teardown", "uninstall"].includes(command)) {
    const syntax = `${command} [codex|claude|hud|tmux|all]`;
    return [usage(syntax), resetNote, options([json, ["--silent", "Hide completion messages", "완료 메시지 숨기기"]]),
      t("Compatibility aliases: reset settings, reset config, teardown, uninstall", "호환 명령: reset settings, reset config, teardown, uninstall"),
      examples(["ai-battery reset", "ai-battery reset claude"])].join("\n\n");
  }
  if (command === "on" || command === "off") {
    return [usage(`${command} [codex|claude|all]`), command === "on"
      ? t("Show the selected tools (default: all).", "선택한 도구의 사용량을 표시합니다. 기본 대상은 all입니다.")
      : t("Hide the selected tools (default: all).", "선택한 도구의 사용량을 숨깁니다. 기본 대상은 all입니다."),
    options([json]), examples([`ai-battery ${command} codex`])].join("\n\n");
  }
  if (command === "doctor") {
    return [usage("doctor [--json]"), t("Check installation, integrations and available updates.", "설치 상태, 연동 설정, 업데이트를 확인합니다."), options([json])].join("\n\n");
  }
  if (command === "capture-claude") {
    return [usage("capture-claude [options]"), t("Read Claude statusLine JSON from stdin and update the usage cache.", "표준 입력으로 Claude 상태 표시줄 JSON을 받아 사용량 캐시를 갱신합니다."),
      options([providers, ...colorOptions, barWidth, leftPadding, showPaths, ...headerOptions,
        ...(platform === "win32" ? [["--attach-hud", "Attach the Windows terminal HUD", "Windows 터미널에 HUD 연결"]] : []),
        ["--silent", "Update the cache without output", "출력 없이 캐시 갱신"]])].join("\n\n");
  }
  if (command === "hud") {
    return [usage("hud [start|stop|status] [options]"),
      t("Desktop usage display for Linux, macOS, Windows and WSL.", "Linux·macOS·Windows·WSL용 데스크톱 사용량 표시입니다."),
      `${t("Commands", "명령")}:\n${rows([
        ["start", "Start the display (default)", "사용량 표시 시작 (기본)"],
        ["stop", "Stop the display", "사용량 표시 종료"],
        ["status", "Show display status", "실행 상태 확인"],
        ["autostart on|off|status", "Manage login startup", "로그인 시 자동 실행 관리"]
      ])}`,
      options(["darwin", "linux"].includes(platform) ? [
        ["--interval seconds", "Refresh interval (default: 10s)", "갱신 간격 (기본: 10초)"], providers,
        ["--once", "Print panel text once", "패널 텍스트 한 번 출력"],
        ["--foreground", "Run in the foreground", "포그라운드에서 실행"]
      ] : [
        ["light|dark", "Match light or dark taskbar colors", "밝은·어두운 작업 표시줄에 맞춤"],
        ["black|white", "Choose text color", "글자색 선택"],
        ["--backdrop [on|off]", "Toggle the background", "배경 표시 설정"],
        ["--dock-console", "Attach to the current terminal", "현재 터미널에 연결"],
        ["--dock-window HWND", "Attach to a specific window", "지정한 창에 연결"],
        ["--dock-position bottom|tabs", "Choose the docking position", "표시 위치 선택"]
      ]),
      examples(["ai-battery hud", "ai-battery hud autostart on"])
    ].join("\n\n");
  }
  return [
    t("AI Battery · Codex and Claude Code usage", "AI Battery · Codex와 Claude Code 사용량"),
    usage("[command] [options]"),
    `${t("Commands", "명령")}:\n${rows([
      ["setup", "Configure usage display", "사용량 표시 연동"],
      ["hud", "Manage the desktop usage display", "데스크톱 사용량 표시 관리"],
      ["on / off", "Show or hide a tool", "도구별 사용량 표시 켜기·끄기"],
      ["reset", "Restore settings and clean generated files", "설정 복원 및 생성 파일 정리"],
      ["doctor", "Check installation and integrations", "설치 및 연동 상태 진단"]
    ])}`,
    options([["-w, --watch [seconds]", "Refresh periodically (default: 10s)", "주기적으로 갱신 (기본: 10초)"],
      ["-v, --version", "Show version", "버전 확인"], ["-h, --help", "Show help", "도움말 보기"]]),
    examples(["ai-battery setup claude", "ai-battery hud", "ai-battery on codex"]),
    t("More help: ai-battery <command> --help", "상세 도움말: ai-battery <명령> --help")
  ].join("\n\n");
}
