# --- build the review UI
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# --- runtime: Python + Tesseract (Persian, best-accuracy models)
FROM python:3.11-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fas curl ca-certificates libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
# tessdata_best is markedly more accurate for Persian than the distro models.
RUN mkdir -p /opt/tessdata_best \
 && for l in fas eng osd; do \
      curl -fsSL -o /opt/tessdata_best/$l.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/$l.traineddata \
      || cp /usr/share/tesseract-ocr/5/tessdata/$l.traineddata /opt/tessdata_best/; \
    done
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ ./
COPY --from=ui /ui/dist /app/frontend/dist
ENV TESSDATA_DIR=/opt/tessdata_best DATA_DIR=/data PATH="/app/backend/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
