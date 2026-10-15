# AI Battery

0.1.22: La configuración predeterminada de Codex conserva su comando, PATH y ajustes. `reset settings` restaura las integraciones y limpia archivos generados. Conserva el paquete npm; su eliminación se hace por separado con npm.

[한국어](../../../README.md) · [English](../en/) · [日本語](../ja/) · [中文](../zh/) · [Español](../es/)

Medidor de batería de uso para Codex y Claude

Una herramienta de estado para terminal que muestra el uso restante de Codex y Claude Code como si fuera una batería.

![npm](https://img.shields.io/npm/v/ai-battery)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[Instalación](#install) · [Funciones](#features) · [Inicio rápido](#quick-start) · [Claude StatusLine](#claude-statusline) · [HUD de escritorio](#desktop-hud) · [Precauciones](#caution)

<a id="overview"></a>
## Descripción general

`ai-battery` es una pequeña herramienta de estado para comprobar continuamente el uso restante y las horas de reinicio mientras usas Codex y Claude Code.

Para Codex, lee eventos `rate_limits` desde los registros de sesiones locales. Para Claude Code, almacena en caché el payload de rate-limit que entrega el hook `statusLine`. Si Claude registra un 429 rate-limit hit real, ese límite se refleja como 0% hasta su reset correspondiente. La salida predeterminada se mantiene compacta en una sola línea: las herramientas en ejecución se muestran en blanco, las inactivas en gris, y solo la barra de batería cambia de color según el uso restante: verde, naranja o rojo.

<img src="../../terminal-preview.svg" alt="AI Battery terminal preview showing green and red battery bars" width="940">

El fallback de texto en Markdown omite la barra para evitar diferencias de altura en caracteres de bloque según el renderizador. En una terminal real, los colores ANSI y las barras de bloque se renderizan juntos.

```text
Codex 86% │ 5h 18:09 │ 7d 82%  ┃  Claude 4% │ 5h 18:10 │ 7d 71%
```

| Proveedor | Fuente | Muestra |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | Restante 5h, hora de reset 5h, restante 7d |
| Claude Code | Claude `statusLine` payload cache + 429 hit logs | Restante 5h, hora de reset 5h, restante 7d |
| Claude fallback | `~/.claude/projects/**/*.jsonl` | Uso de tokens del turno reciente |

<a id="features"></a>
## Funciones

| Función | Descripción |
| --- | --- |
| Visualización común de uso | Muestra el uso de Codex y Claude Code con el mismo formato. |
| Hora de reset | Muestra las etiquetas y valores de las ventanas `5h` y `7d`. |
| Criterios de color | Resalta solo la batería: verde sobre 40%, naranja entre 21-40% y rojo en 20% o menos. |
| Codex terminal row | Proporciona un PTY wrapper que fija una fila de uso dedicada debajo de Codex. |
| Claude statusLine | Lee el estado de rate limit de Claude desde el hook statusLine integrado de Claude Code y los registros reales de 429 hit. |
| HUD / menu bar | Proporciona un HUD flotante en Windows nativo/WSL y un elemento de barra de menús en macOS. |
| Ejecución con npm | Puede ejecutarse con `npm install -g` o `npx`. |

<a id="platform-support"></a>
## Compatibilidad de plataformas

| Modo | Windows nativo | WSL | Linux | macOS | Nota |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | Compatible | Compatible | Compatible | Compatible | Requiere Node.js 18 o posterior. |
| `ai-battery --watch` | Compatible | Compatible | Compatible | Compatible | Se actualiza periódicamente dentro de la terminal. |
| Claude statusLine | Compatible | Compatible | Compatible | Compatible | Guarda un comando `node <script>` en Claude Code `statusLine`. |
| Codex terminal row | Compatible | Compatible | Compatible | Compatible | Windows: fullscreen PTY composition; WSL/Linux/macOS: POSIX PTY and Python 3. |
| `ai-battery setup codex` | Compatible | Compatible | Compatible | Compatible | Retira wrappers anteriores de AI Battery. Los wrappers nuevos y los cambios de ajustes requieren opciones explícitas. |
| `ai-battery hud` | Compatible | Compatible | No compatible | Compatible | Windows/WSL usan un HUD PowerShell/WinForms; macOS usa un elemento de barra de menús. |

La detección de procesos en ejecución usa `/proc` en Linux/WSL, `ps` en macOS y listados de procesos de PowerShell en Windows. La salida de texto usa blanco/gris; el HUD de macOS resalta solo los elementos en ejecución con barras de batería de color y muestra los elementos inactivos en gris tenue.

<a id="install"></a>
## Instalación

```bash
npm install -g ai-battery
```

También puedes ejecutarlo directamente sin instalarlo.

```bash
npx ai-battery
```

Los nombres anteriores, `claudex-battery`, `claudex-battery-run` y `claudex-battery-hud`, siguen disponibles como alias de compatibilidad.

<a id="quick-start"></a>
## Inicio rápido

1. Instala el paquete.

   ```bash
   npm install -g ai-battery
   ```

2. Configura el statusLine de Claude y retira wrappers anteriores de Codex.

   ```bash
   ai-battery setup
   ```

3. Después, sigue usando los comandos originales como siempre.

   ```bash
   claude
   codex
   ```

4. Consulta el uso de Codex con `ai-battery --watch 2` o el HUD en plataformas compatibles.

   ```bash
   ai-battery hud
   ```

<a id="cli"></a>
## CLI

```bash
ai-battery
ai-battery --watch 10
ai-battery --json
ai-battery --version
ai-battery --provider codex
ai-battery --provider claude
ai-battery setup
ai-battery reset settings
ai-battery doctor
ai-battery hud
ai-battery off codex
ai-battery on codex
```

| Opción | Descripción |
| --- | --- |
| `--provider all\|codex\|claude` | Elige qué provider mostrar. |
| `--watch [seconds]` | Se actualiza periódicamente en la misma línea. |
| `--json` | Produce JSON útil para HUDs u otras herramientas. |
| `--bar-width N` | Ajusta el ancho de la barra de batería en la terminal. |
| `--show-paths` | Muestra rutas de archivos de log y timestamps de observación de datos. |
| `-v`, `--version` | Imprime la versión instalada de `ai-battery`. |

`doctor` comprueba el estado de instalación y la versión latest de npm. Si la red está bloqueada, solo se omite la comprobación de versión y el resto del diagnóstico se sigue mostrando.

<a id="uninstall"></a>
## Reset Settings

`ai-battery reset settings` restaura los ajustes modificados por AI Battery y limpia sus cachés, runtimes privados y archivos generados verificados. Conserva otros ajustes de Codex/Claude y los paquetes npm. No restablece todos los ajustes de Codex/Claude. `reset config` es un alias.

```bash
ai-battery reset settings
```

Para una sola integración usa `ai-battery reset settings codex` / `claude` / `hud` / `tmux`. Conserva archivos modificados o de propiedad desconocida y registros de recuperación pendientes.

Elimina el paquete con npm después de restaurar los ajustes correctamente. Las instalaciones locales usan `npm uninstall ai-battery`. `uninstall` y `teardown` son alias de compatibilidad para restaurar ajustes y nunca ejecutan npm. Ejecuta cada instalación de Windows y WSL por separado. Limpia la caché de Bash con `hash -r` o la de zsh con `rehash`.

```bash
ai-battery reset settings && npm uninstall -g ai-battery
```

<a id="setup"></a>
## Configuración

`setup` configura el hook statusLine de Claude. Codex se ejecuta de forma independiente y solo se restauran wrappers y ajustes administrados de versiones anteriores. Consulta el uso con `ai-battery --watch 2` o `ai-battery hud` en plataformas compatibles.

```bash
ai-battery setup
ai-battery setup codex
```

Solo `ai-battery setup codex --wrap-codex` instala un wrapper en PATH. Cambiar `[tui].status_line` de Codex requiere además `--configure-codex-statusline`. Los modos composite/HUD de Windows se aplican al ejecutar el runner directamente o elegir el wrapper.

En tmux, reservar una fila inferior en cada pane duplicaría la misma batería global tantas veces como panes haya. En su lugar, puedes mostrarla una sola vez por sesión en la status bar de tmux.

```bash
ai-battery setup tmux
```

Esto agrega un bloque administrado a `~/.tmux.conf`, muestra la batería en `status-right` con actualización cada 10 segundos, y hace que `codex` dentro de tmux use todo el pane en lugar de añadir una fila de batería por pane. Claude statusLine también colapsa la fila de batería en el mismo entorno y muestra solo la fila de encabezado (modelo, directorio, rama), porque la batería ya está en la barra de tmux. Para aplicarlo, ejecuta `tmux source-file ~/.tmux.conf` y abre un nuevo pane. Este bloque sobrescribe la configuración existente de `status-right`, por lo que es opt-in y no se incluye en `setup all`. Se elimina con `ai-battery reset settings tmux`; si quieres mantener filas por pane dentro de tmux, configura `AI_BATTERY_TMUX=row`. Claude statusLine forma parte de la UI interna de Claude Code, así que se muestra independientemente de tmux.

Si la fila inferior de Codex no aparece, ejecuta el diagnóstico.

```bash
ai-battery doctor
```

El provider mostrado se cambia con comandos cortos on/off.

```bash
ai-battery off codex
ai-battery on codex
ai-battery off claude
ai-battery on claude
ai-battery off all
ai-battery on all
```

Esta configuración se aplica conjuntamente a la CLI, Claude statusLine, Codex wrapper y HUD.

<a id="codex-terminal-row"></a>
## Fila de terminal de Codex

El comando normal `codex` se ejecuta independientemente de AI Battery. Para añadir una fila a una sola sesión:

```bash
ai-battery-run --provider all -- codex       # WSL/Linux/macOS
ai-battery-run-win --provider all -- codex   # Windows cmd/PowerShell
```

<a id="claude-statusline"></a>
## Claude StatusLine

Claude Code proporciona el uso de rate-limit y las horas de reset mediante el hook integrado `statusLine`. AI Battery combina eso con registros reales de 429 rate-limit hit en los JSONL de Claude. Después de la instalación, Claude renderiza dos líneas.

<img src="../../claude-statusline-preview.svg" alt="Claude statusLine preview showing colored AI Battery bars" width="940">

```text
Opus high · ~/Projects · main                               83% context left
Codex 71% │ 5h 00:47 │ 7d 90%  Claude 76% │ 5h 00:47 │ 7d 59%
```

La primera línea muestra el modelo, nivel de razonamiento, workspace root y git branch, con el contexto restante de Claude fijado al borde derecho. La segunda línea muestra el uso de Codex y Claude con el mismo formato.

Configuración:

```bash
ai-battery setup claude
```

Eliminar:

```bash
ai-battery reset settings claude
```

Claude debe entregar al menos una vez un payload de statusLine para que se cree la caché de uso de Claude. Hasta entonces se muestra el fallback basado en registros locales de Claude.

<a id="desktop-hud"></a>
## HUD de escritorio

Dibujar de forma segura una status line sobre una terminal normal desde un proceso externo no es estable. Por eso AI Battery proporciona un overlay flotante en Windows y un elemento de barra de menús superior en macOS. En Windows nativo se ejecuta directamente con PowerShell/WinForms sin WSL; desde WSL, inicia el mismo HUD mediante `powershell.exe`. En macOS muestra logos de Codex y Claude, medidores compactos y porcentajes como una pequeña imagen SVG con fondo transparente. Al hacer clic se puede ver el estado detallado.

```bash
ai-battery hud
```

El HUD se ejecuta en segundo plano y devuelve inmediatamente el control a la terminal. El HUD de Windows puede moverse arrastrándolo y reutiliza la posición guardada en el siguiente inicio. El elemento de barra de menús de macOS aparece en el área derecha de la barra de menús del sistema.

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| Comando | Rol |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | Inicia el HUD flotante de Windows o el elemento de barra de menús de macOS. |
| `ai-battery hud stop` | Detiene el HUD/menu bar item en ejecución. (`--stop` es equivalente.) |
| `ai-battery hud status` | Muestra si el HUD/menu bar item está en ejecución y si autostart está registrado. |
| `ai-battery hud autostart on` | Registra el inicio automático al iniciar sesión en Windows o macOS. |
| `ai-battery hud autostart off` | Elimina el registro de inicio automático. |
| `ai-battery hud autostart status` | Muestra solo el estado de registro de autostart. |
| `ai-battery hud -Foreground` | Ejecuta adjunto a la terminal para depuración. |
| `ai-battery hud -Once` | Imprime una sola vez en la consola. |
| `ai-battery hud -Interval 2` | Cambia el intervalo de actualización. |
| `ai-battery hud -Mode tray` | Ejecuta en modo Windows tray icon. En macOS, el elemento de barra de menús es el predeterminado. |
| `ai-battery hud light` / `ai-battery hud dark` | Cambia el HUD flotante de Windows a texto negro para una barra de tareas clara o texto blanco para una barra de tareas oscura. |
| `ai-battery hud black` / `ai-battery hud white` | Cambia directamente el color del texto a negro o blanco. |
| `ai-battery hud --backdrop` / `ai-battery hud --no-backdrop` | Activa o desactiva el fondo oscuro detrás del texto del HUD flotante de Windows. |

El HUD flotante de Windows usa por defecto texto claro sobre fondo transparente. En una barra de tareas clara usa `ai-battery hud light`; en una oscura usa `ai-battery hud dark`. Para elegir el color de texto directamente, usa `ai-battery hud black` o `ai-battery hud white`. Para guardar el mismo modo en el inicio automático, añade el modo como en `ai-battery hud autostart on light`.

El autostart de Windows se registra por usuario en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. En Windows nativo se ejecuta directamente sin WSL; si se registra desde WSL, se coloca una copia del script HUD en `%LOCALAPPDATA%\ai-battery`. El autostart de macOS se registra como `~/Library/LaunchAgents/com.ai-battery.hud.plist`. Después de actualizar ai-battery, ejecuta de nuevo `ai-battery hud autostart on` para refrescar la ruta registrada.

<a id="shell-prompt"></a>
## Prompt de shell

También puedes añadirlo al prompt de shell.

```bash
export PS1='$(ai-battery --provider codex) '"$PS1"
```

El método de prompt se actualiza cada vez que se ejecuta un comando. Usa `ai-battery setup` o `ai-battery hud` si necesitas una visualización persistente.

<a id="how-it-works"></a>
## Cómo funciona

```mermaid
flowchart LR
    C[Codex session logs] --> R[ai-battery reader]
    S[Claude statusLine payload] --> K[Claude cache]
    K --> R
    L[Claude local logs] --> F[Fallback token view]
    F --> R
    R --> T[Terminal output]
    R --> P[PTY reserved row]
    R --> H[Desktop HUD / menu bar]
```

Codex busca eventos `rate_limits` en los registros de sesiones recientes. Claude Code proporciona uso y horas de reset mediante el payload statusLine, y los registros reales de 429 rate-limit hit se reflejan como 0% hasta el reset. En modo fallback, solo se puede consultar el uso reciente de tokens.

<a id="tech-stack"></a>
## Stack técnico

| Capa | Tecnología | Rol |
| --- | --- | --- |
| CLI | Node.js | Parseo de logs, Claude cache, salida ANSI/statusLine |
| PTY row | Python 3 | Reserved terminal row para ejecutar Codex |
| HUD launcher | Node.js / Bash compatibility wrapper | Lanza el HUD PowerShell de Windows nativo/WSL y la barra de menús de macOS |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Overlay flotante de Windows, tray icon, elemento de barra de menús de macOS |
| Data | JSONL logs, statusLine JSON | Fuentes de uso de Codex/Claude |

<a id="source-environment"></a>
## Entorno de origen

Node.js 18+ supports the CLI. Windows defaults to `composite`: PATH-selected Codex runs in bundled ConPTY, and `@xterm/headless` composes its fullscreen display above one battery row. If Windows VT raw input is unavailable, a private SHA256-verified Node 24.21.0 is installed without changing system Node or PATH. Runtime/dependency failure falls back to the native HUD. `auto` selects composite; `fullscreen`/`hud` explicitly select the HUD. `plain` disables the display. Legacy rowpty modes remain opt-in. WSL/Linux/macOS use Python 3 and POSIX PTY.

Los datos se leen del directorio `sessions` del `CODEX_HOME` que usa realmente Codex (`~/.codex` por defecto). AI Battery nunca configura ni cambia `HOME`, `USERPROFILE` o `CODEX_HOME`. Cambiar `CODEX_HOME` también cambia el almacén `/resume` de Codex, por lo que no debe usarse para combinar rutas de Windows y WSL. No se admiten varios homes separados por comas.

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

Al usar Windows nativo y WSL juntos, cada entorno conserva sus propias sesiones y su historial `/resume`. Solo se comparte el uso global 5h/7d de la cuenta mediante el archivo `codex-account-usage.json` de AI Battery; no se comparten rutas de sesión, workspaces ni modos de aprobación/sandbox.

La visualización de uso de Claude está disponible después de instalar el hook statusLine de Claude Code.

<a id="caution"></a>
## Precauciones

- Esta herramienta lee registros locales y payloads de Claude statusLine. No reemplaza la pantalla oficial de facturación o límites del servicio.
- Si los eventos de Codex rate limit aún no se han generado o están desactualizados, la visualización puede diferir del estado más reciente.
- Claude statusLine solo proporciona uso y hora de reset, por lo que el estado real de hit se combina con los registros 429 rate-limit dejados por Claude.
- El HUD se basa en PowerShell/WinForms en Windows y en un elemento de barra de menús en macOS. En WSL usa `powershell.exe` y `wsl.exe` juntos.
- `ai-battery-run` es un PTY wrapper. Algunas TUI de pantalla completa pueden mover brevemente la status row debido a escape sequences que limpian la pantalla.
