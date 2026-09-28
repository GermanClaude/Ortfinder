@echo off
setlocal EnableExtensions
title Ortfinder - KI auf diesem PC (Ollama)
rem Ortfinder: KI auf dem eigenen PC (Ollama) - unbegrenzt und kostenlos.
rem Startet Ollama mit Freigabe fuer Ortfinder, laedt beim ersten Mal das Modell und oeffnet - falls
rem cloudflared installiert ist - einen Tunnel, damit auch das Handy die KI dieses PCs nutzen kann.
rem Anderes Modell, z.B. fuer schwaechere PCs:  ortfinder-ki-windows.bat qwen3.5:4b

set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=gemma4:12b"
set "APP=https://germanclaude.github.io/Ortfinder/docs/"
set "PORT=11434"

where ollama >nul 2>nul
if errorlevel 1 (
  echo Ollama ist nicht installiert. Bitte zuerst installieren: https://ollama.com/download
  start "" "https://ollama.com/download"
  pause
  exit /b 1
)

echo Beende ein laufendes Ollama, damit die Freigabe fuer Ortfinder wirkt ...
taskkill /IM "ollama app.exe" /F >nul 2>nul
taskkill /IM "ollama.exe" /F >nul 2>nul
timeout /t 2 /nobreak >nul

echo Starte Ollama mit Freigabe fuer Ortfinder ...
set "OLLAMA_ORIGINS=https://germanclaude.github.io"
start "Ollama fuer Ortfinder" /min ollama serve

set /a TRIES=0
:wait
curl -s http://localhost:%PORT%/api/version >nul 2>nul
if not errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% geq 30 goto notstarted
timeout /t 1 /nobreak >nul
goto wait

:notstarted
echo Ollama ist nicht gestartet. Bitte Ollama neu installieren oder den PC neu starten.
pause
exit /b 1

:ready
echo Lade das Modell %MODEL% - nur beim ersten Mal, einige GB ...
ollama pull %MODEL%
if errorlevel 1 goto failed

echo.
echo Fertig. Am PC: %APP% oeffnen und unter Einstellungen "Eigener PC (Ollama)" waehlen.
where cloudflared >nul 2>nul
if errorlevel 1 goto notunnel

echo Starte den Tunnel fuers Handy ...
set "TLOG=%TEMP%\ortfinder-tunnel.log"
if exist "%TLOG%" del "%TLOG%"
start "Tunnel fuer Ortfinder" /min cloudflared tunnel --url http://localhost:%PORT% --http-host-header localhost:%PORT% --logfile "%TLOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 90; $i++) { if (Test-Path $env:TLOG) { $m = Select-String -Path $env:TLOG -Pattern 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $u = $m.Matches[0].Value; Write-Host ''; Write-Host ('Tunnel fuers Handy: ' + $u); Write-Host 'Ortfinder oeffnet sich jetzt mit dem QR-Code zum Scannen.'; Write-Host 'Wer diese Adresse kennt, kann die KI dieses PCs nutzen - nicht weitergeben.'; Start-Process ($env:APP + '#ki=http://localhost:' + $env:PORT + '&modell=' + $env:MODEL + '&handy=' + $u); exit 0 } }; Start-Sleep -Seconds 1 }; Write-Host ('Der Tunnel hat keine Adresse geliefert. Details: ' + $env:TLOG); exit 1"
goto keepopen

:notunnel
echo.
echo Fuers Handy zusaetzlich cloudflared installieren und dieses Skript neu starten:
echo   winget install --id Cloudflare.cloudflared
start "" "%APP%#ki=http://localhost:%PORT%&modell=%MODEL%"

:keepopen
echo.
echo Ollama laeuft, solange dieses Fenster offen ist.
echo Zum Beenden hier eine Taste druecken.
pause >nul
taskkill /IM cloudflared.exe /F >nul 2>nul
taskkill /IM ollama.exe /F >nul 2>nul
exit /b 0

:failed
echo Das Modell %MODEL% konnte nicht geladen werden. Internetverbindung und Modellnamen pruefen.
pause
exit /b 1
