@echo off
rem Hauskarte-Server: startet den Server und startet ihn nach Absturz oder Update automatisch neu
cd /d "%~dp0"
if not exist daten mkdir daten
set "N=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "N=%ProgramFiles%\nodejs\node.exe"
if exist node-path.txt set /p N=<node-path.txt
:loop
"%N%" server.js >> daten\server.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
