#!/usr/bin/env bash
# Ortfinder: KI auf dem eigenen PC (Ollama) – unbegrenzt und kostenlos.
# Startet Ollama mit Freigabe für Ortfinder, lädt beim ersten Mal das Modell und öffnet – falls
# cloudflared installiert ist – einen Tunnel, damit auch das Handy die KI dieses PCs nutzen kann.
#
#   bash ortfinder-ki-mac-linux.sh              # Standardmodell gemma4:12b
#   bash ortfinder-ki-mac-linux.sh qwen3.5:4b   # anderes Modell (z.B. für schwächere PCs)
set -u
MODEL="${1:-gemma4:12b}"
ORIGIN="https://germanclaude.github.io"
APP="https://germanclaude.github.io/Ortfinder/docs/"
PORT=11434
LOG="${TMPDIR:-/tmp}/ortfinder-ollama.log"

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  fi
}

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama ist nicht installiert. Bitte zuerst installieren: https://ollama.com/download"
  open_url "https://ollama.com/download"
  exit 1
fi

# A running Ollama (desktop app or service) would not know the Ortfinder permission, so stop it.
if [ "$(uname)" = "Darwin" ]; then osascript -e 'quit app "Ollama"' >/dev/null 2>&1; fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ollama 2>/dev/null; then
  echo "Der Ollama-Systemdienst läuft. Bitte anhalten und das Skript erneut starten:"
  echo "  sudo systemctl stop ollama"
  exit 1
fi
pkill -x ollama >/dev/null 2>&1 && sleep 2

echo "Starte Ollama mit Freigabe für Ortfinder …"
OLLAMA_ORIGINS="$ORIGIN" ollama serve >"$LOG" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 30); do
  curl -s "http://localhost:$PORT/api/version" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -s "http://localhost:$PORT/api/version" >/dev/null 2>&1; then
  echo "Ollama ist nicht gestartet. Details: $LOG"
  exit 1
fi

echo "Lade das Modell $MODEL (nur beim ersten Mal, einige GB) …"
ollama pull "$MODEL" || exit 1

echo
echo "Fertig. Am PC: $APP öffnen, unter ⚙ „Eigener PC (Ollama)“ wählen."
if command -v cloudflared >/dev/null 2>&1; then
  echo "Starte den Tunnel fürs Handy …"
  cloudflared tunnel --url "http://localhost:$PORT" --http-host-header "localhost:$PORT" 2>&1 | while IFS= read -r line; do
    url=$(printf '%s\n' "$line" | grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | head -n 1)
    if [ -n "$url" ]; then
      link="${APP}#ki=http://localhost:$PORT&modell=$MODEL&handy=$url"
      echo
      echo "Tunnel fürs Handy: $url"
      echo "Ortfinder öffnet sich jetzt mit dem QR-Code zum Scannen."
      echo "(Wer diese Adresse kennt, kann die KI dieses PCs nutzen – nicht weitergeben.)"
      echo
      open_url "$link"
    fi
  done
else
  echo "Fürs Handy zusätzlich cloudflared installieren und das Skript neu starten:"
  echo "  Mac:   brew install cloudflared"
  echo "  Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  open_url "${APP}#ki=http://localhost:$PORT&modell=$MODEL"
  echo
  echo "Ollama läuft, solange dieses Fenster offen ist (beenden mit Strg+C)."
  wait "$SERVER"
fi
