@echo off
rem fake-liepin.cmd - Windows test stub, aligned with fake-liepin.sh tested branches:
rem   sleep-long (never exits -> timeout) / big-output (>64KB output) / default (JSON with Chinese name).
rem Chinese text is embedded as base64 (UTF-8) and re-encoded to the platform default charset
rem (ANSI; GBK on Chinese Windows) so that decoding matches the JVM default charset.
setlocal

if "%~1"=="sleep-long" (
  ping -n 61 127.0.0.1 >nul 2>nul
  exit /b 0
)

if "%~1"=="big-output" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$lb=[Text.Encoding]::Default.GetBytes([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('W3sibmFtZSI6IuWAmemAieS6uuWNoOS9jSIsInJlc3VtZV9pZCI6InItYmlnLTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAifV0=')));$nl=[byte[]](13,10);$out=[Console]::OpenStandardOutput();for($i=0;$i -lt 2000;$i++){$out.Write($lb,0,$lb.Length);$out.Write($nl,0,2)};$out.Flush()"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lb=[Text.Encoding]::Default.GetBytes([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('W3sibmFtZSI6Ium7mOiupOWAmemAieS6uiIsInJlc3VtZV9pZCI6InIwIn1d')));$nl=[byte[]](13,10);$out=[Console]::OpenStandardOutput();$out.Write($lb,0,$lb.Length);$out.Write($nl,0,2);$out.Flush()"
exit /b 0
