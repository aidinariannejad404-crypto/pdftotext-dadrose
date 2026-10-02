#!/usr/bin/env bash
# DADROSE OCR — one-step local start on macOS / Linux.
#   ./scripts/start.sh            first run / normal start
#   ./scripts/start.sh --rebuild  after pulling new code
# Needs: uv, Node.js 20+, Tesseract with Persian
#   macOS:  brew install uv node tesseract tesseract-lang
#   Ubuntu: sudo apt install tesseract-ocr tesseract-ocr-fas nodejs npm && curl -LsSf https://astral.sh/uv/install.sh | sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"
TESSDATA="$ROOT/tessdata_best"

for cmd in uv npm tesseract; do
  command -v "$cmd" >/dev/null || { echo "[!] $cmd not found — see the install hints at the top of this script"; exit 1; }
done

mkdir -p "$TESSDATA"
for lang in fas eng osd; do
  [ -f "$TESSDATA/$lang.traineddata" ] && continue
  echo "downloading $lang model ..."
  curl -fsSL -o "$TESSDATA/$lang.traineddata" \
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/$lang.traineddata" || {
      rm -f "$TESSDATA/$lang.traineddata"
      echo "  download failed; the installed (less accurate) $lang model will be used"
    }
done

ENV_FILE="$ROOT/backend/.env"
[ -f "$ENV_FILE" ] || cp "$ROOT/backend/.env.example" "$ENV_FILE"
grep -vE '^(TESSDATA_DIR|TESSERACT_CMD)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
if [ -f "$TESSDATA/fas.traineddata" ]; then echo "TESSDATA_DIR=$TESSDATA" >> "$ENV_FILE.tmp"; fi
mv "$ENV_FILE.tmp" "$ENV_FILE"

if [ "${1:-}" = "--rebuild" ] || [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  (cd "$ROOT/frontend" && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build)
fi

cd "$ROOT/backend"
uv sync --no-dev
echo "==> http://127.0.0.1:$PORT  (Ctrl+C to stop)"
( sleep 4; (command -v open >/dev/null && open "http://127.0.0.1:$PORT") || (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$PORT") || true ) &
exec uv run --no-dev uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
