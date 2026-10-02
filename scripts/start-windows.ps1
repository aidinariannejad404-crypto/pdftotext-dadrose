# DADROSE OCR — one-step local start on Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1            (first run / normal start)
#   powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Rebuild   (after pulling new code)
#
# Needs: uv (Python manager), Node.js 20+, Tesseract OCR (UB Mannheim build).
# Opens http://127.0.0.1:8000 when ready. Stop with Ctrl+C.

param([switch]$Rebuild, [int]$Port = 8000)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$TessData = Join-Path $Root "tessdata_best"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`n[!] $msg" -ForegroundColor Red; exit 1 }

# ---- 1. prerequisites
Step "Checking prerequisites"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "uv not found. Install it:  powershell -ExecutionPolicy Bypass -c `"irm https://astral.sh/uv/install.ps1 | iex`"  then open a new terminal."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "Node.js not found. Install the LTS version from https://nodejs.org and open a new terminal."
}
$Tesseract = (Get-Command tesseract -ErrorAction SilentlyContinue).Source
if (-not $Tesseract) {
    foreach ($p in @("C:\Program Files\Tesseract-OCR\tesseract.exe", "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe")) {
        if (Test-Path $p) { $Tesseract = $p; break }
    }
}
if (-not $Tesseract) {
    Fail "Tesseract not found. Install it from https://github.com/UB-Mannheim/tesseract/wiki (tick 'Persian' under Additional language data), then re-run."
}
Write-Host "uv: OK   node: OK   tesseract: $Tesseract"

# ---- 2. accurate Persian models (tessdata_best)
Step "Persian OCR models (tessdata_best)"
New-Item -ItemType Directory -Force -Path $TessData | Out-Null
foreach ($lang in @("fas", "eng", "osd")) {
    $target = Join-Path $TessData "$lang.traineddata"
    if (Test-Path $target) { continue }
    try {
        Write-Host "downloading $lang ..."
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/$lang.traineddata" -OutFile $target
    } catch {
        $fallback = Join-Path (Split-Path $Tesseract) "tessdata\$lang.traineddata"
        if (Test-Path $fallback) {
            Copy-Item $fallback $target
            Write-Host "  download failed; using the installed (less accurate) $lang model" -ForegroundColor Yellow
        } elseif ($lang -eq "fas") {
            Fail "Could not get the Persian model. Download fas.traineddata from github.com/tesseract-ocr/tessdata_best into $TessData"
        }
    }
}

# ---- 3. backend/.env
Step "Configuration (backend\.env)"
$EnvFile = Join-Path $Backend ".env"
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $Backend ".env.example") $EnvFile
    Write-Host "created backend\.env (edit it to add ANTHROPIC_API_KEY or ADMIN_PASSWORD)"
}
$lines = Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -notmatch '^(TESSERACT_CMD|TESSDATA_DIR)=' }
$lines += "TESSERACT_CMD=$Tesseract"
$lines += "TESSDATA_DIR=$TessData"
Set-Content -Path $EnvFile -Value $lines -Encoding UTF8

# ---- 4. review UI
$Dist = Join-Path $Frontend "dist\index.html"
if ($Rebuild -or -not (Test-Path $Dist)) {
    Step "Building the review UI (first time takes a minute)"
    Push-Location $Frontend
    try {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund }
        npm run build
        if ($LASTEXITCODE -ne 0) { Fail "UI build failed (see messages above)." }
    } finally { Pop-Location }
}

# ---- 5. backend
Step "Installing Python dependencies"
Push-Location $Backend
try {
    uv sync --no-dev
    if ($LASTEXITCODE -ne 0) { Fail "uv sync failed (see messages above)." }
    Step "Starting on http://127.0.0.1:$Port  (Ctrl+C to stop)"
    Start-Job -ScriptBlock { param($u) Start-Sleep 4; Start-Process $u } -ArgumentList "http://127.0.0.1:$Port" | Out-Null
    uv run --no-dev uvicorn app.main:app --host 127.0.0.1 --port $Port
} finally { Pop-Location }
