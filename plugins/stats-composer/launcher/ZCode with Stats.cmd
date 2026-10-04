@echo off
REM ZCode with Stats (Windows)
REM
REM Starts ZCode with a local CDP (remote-debugging) port so the stats-composer
REM composer pill can attach. Optional - the plugin works without it
REM (assistant-attached stats line, or the sidecar + /dashboard).
REM
REM How it finds Node: a normal "node" on PATH first; if there is none (common
REM on a plain desktop install), it falls back to the Node that ZCode itself
REM embeds, by running ZCode.exe with ELECTRON_RUN_AS_NODE=1.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%launch-with-stats.mjs"

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

set "APP=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
if not exist "%APP%" set "APP=%ProgramFiles%\ZCode\ZCode.exe"
if exist "%APP%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%APP%" "%SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

echo [stats-composer] Neither node nor ZCode itself was found. 1>&2
echo   Install Node, or set ZCODE_APP_BINARY to your ZCode binary and retry. 1>&2
exit /b 1
