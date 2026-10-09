# Windows fullscreen 수동 확인

`codex/windows-fullscreen-test`는 Windows 터미널 합성 방식과 Codex의 PATH 기반 실행를 확인하기 위한 테스트 브랜치입니다. 기존 0.1.16 작업 트리를 기반으로 하며, 원격 `main`의 0.1.18 HUD 기본 설정과 별도로 검증합니다. 아래 명령은 이 브랜치의 소스 runner를 직접 실행합니다.

Windows Node 24.21.0과 Codex 0.161.0에서 긴 응답, 한글 출력, Backspace, 창 축소·확대와 종료 후 화면 복원은 자동 검사를 통과했습니다. 실제 Windows Terminal에서 장시간 사용하는 안정성, 마우스 선택·복사와 IME는 수동 확인 대상입니다.

## 소스 준비

PowerShell에서 저장소 디렉터리로 이동한 뒤 실행합니다.

```powershell
git fetch origin
git switch codex/windows-fullscreen-test
npm install
node --version
```

아래 compositor 검사는 VT raw input을 지원하는 Node에서 실행하세요. 확인한 버전은 24.21.0입니다. Node 22.15.1에서는 일반 Backspace가 단어를 지우는 문제가 있어, 수정된 runner가 안내 후 추가 행 없는 일반 Codex로 전환합니다.

## 실제 Codex 실행

현재 npm에 설치된 원본 Codex 진입점을 사용합니다.

```powershell
$runner = (Resolve-Path .\bin\ai-battery-run-win.js).Path
$codexJs = Join-Path (npm root -g) '@openai\codex\bin\codex.js'
if (-not (Test-Path $codexJs)) { throw '현재 npm에 설치된 Codex 진입점을 확인하세요.' }
$env:AI_BATTERY_DEBUG_LOG = Join-Path $PWD 'codex-fullscreen-debug.log'
node $runner --layout composite --provider all -- node $codexJs
```

작업할 프로젝트를 지정하려면 마지막 명령 끝에 `-C 'C:\path\to\project'`를 추가하세요. Codex 안에서 `/tui`의 Fullscreen을 선택한 경우, 종료 후 같은 명령으로 다시 실행해야 적용됩니다. 기존 세션을 선택하려면 마지막 명령 끝에 `resume`을 추가할 수 있습니다. Codex의 기존 계정과 세션 저장소를 사용합니다.

통합 행은 Codex와 같은 터미널의 최하단에 표시됩니다. 창 크기를 반복해서 바꾸고 긴 코드·diff 출력 중에 스크롤하거나 선택·복사해 보세요. 한글 IME, 이모지, Backspace, `/resume`에 해당하는 `resume` 실행과 종료 후 PowerShell 입력도 확인하세요. 문제가 있으면 실행한 Node·Codex 버전과 `codex-fullscreen-debug.log`를 기록해 두세요.

## 사용량 없는 자동 검사

```powershell
npm run smoke:codex-fullscreen-win
```

실제 Windows Codex와 ConPTY를 사용하며, 임시 `CODEX_HOME`과 프로젝트를 만들고 localhost의 모의 Responses API로 응답합니다. 결과는 `codex-fullscreen-check-report.json`에 저장됩니다.

구형 Node에서 안전한 일반 실행 전환을 확인하려면 다음 명령을 사용합니다.

```powershell
node .\scripts\windows-codex-fullscreen-check.mjs --expect-plain
```
