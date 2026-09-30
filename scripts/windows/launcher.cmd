@echo off
rem m365proxy-managed-shim-v1
setlocal EnableExtensions DisableDelayedExpansion
set "PREFIX=%~dp0.."
if not exist "%PREFIX%\current.txt" (
  >&2 echo Installation incomplete: current.txt is missing. Reinstall m365proxy.
  exit /b 1
)
set "APP="
set /p "APP="<"%PREFIX%\current.txt"
if not defined APP (
  >&2 echo Installation incomplete: current.txt is empty. Reinstall m365proxy.
  exit /b 1
)
if not exist "%APP%\.node-path" (
  >&2 echo Installation incomplete: .node-path is missing. Reinstall m365proxy.
  exit /b 1
)
set "NODE="
set /p "NODE="<"%APP%\.node-path"
if not defined NODE (
  >&2 echo Installation incomplete: .node-path is empty. Reinstall m365proxy.
  exit /b 1
)
if not exist "%NODE%" (
  >&2 echo Configured Node is missing. Re-run install.ps1.
  exit /b 1
)
"%NODE%" "%PREFIX%\bin\m365proxy-launcher.mjs" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
