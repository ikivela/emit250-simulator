@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0Emit250Simulator.ps1"
if errorlevel 1 pause

