@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0teamai-askpass.ps1" "%~1"
