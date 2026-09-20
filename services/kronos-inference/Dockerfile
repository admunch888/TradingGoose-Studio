# syntax=docker/dockerfile:1

# Model weights are fetched at build time from pinned Hugging Face revisions, so
# the image is self-contained and the runtime can stay offline (HF_HUB_OFFLINE).
# The revisions must match kronos_api/config.py (tests/test_container_packaging.py).
FROM python:3.11-slim AS weights

ARG KRONOS_MODEL_REPO=NeoQuasar/Kronos-base
ARG KRONOS_MODEL_REVISION=2b554741eca47781b64468546e77fef3e85130e6
ARG KRONOS_TOKENIZER_REPO=NeoQuasar/Kronos-Tokenizer-base
ARG KRONOS_TOKENIZER_REVISION=0e0117387f39004a9016484a186a908917e22426

RUN pip install --no-cache-dir "huggingface-hub>=0.33,<2" && \
    python -c "import os; from huggingface_hub import snapshot_download as fetch; files = ['config.json', 'model.safetensors']; fetch(os.environ['KRONOS_MODEL_REPO'], revision=os.environ['KRONOS_MODEL_REVISION'], local_dir='/models/kronos-base', allow_patterns=files); fetch(os.environ['KRONOS_TOKENIZER_REPO'], revision=os.environ['KRONOS_TOKENIZER_REVISION'], local_dir='/models/kronos-tokenizer-base', allow_patterns=files)" && \
    rm -rf /models/kronos-base/.cache /models/kronos-tokenizer-base/.cache && \
    test -f /models/kronos-base/model.safetensors && \
    test -f /models/kronos-tokenizer-base/model.safetensors

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    HF_HUB_OFFLINE=1 \
    TORCH_HOME=/models

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://astral.sh/uv/install.sh | sh && \
    apt-get purge -y --auto-remove curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:${PATH}"
ENV PYTHONPATH="/app/src:/app/third_party/kronos"

COPY pyproject.toml uv.lock ./
RUN uv pip install --system --index https://download.pytorch.org/whl/cpu --default-index https://pypi.org/simple .

COPY src ./src
COPY third_party/kronos/model ./third_party/kronos/model
COPY third_party/kronos/LICENSE ./third_party/kronos/LICENSE
COPY third_party/kronos/UPSTREAM_REVISION ./third_party/kronos/UPSTREAM_REVISION

COPY --from=weights /models/kronos-base /models/kronos-base
COPY --from=weights /models/kronos-tokenizer-base /models/kronos-tokenizer-base

LABEL org.opencontainers.image.title="TradingGoose Kronos Inference" \
      org.opencontainers.image.description="Private Kronos-base forecasting service for TradingGoose" \
      kronos.source.revision="67b630e67f6a18c9e9be918d9b4337c960db1e9a" \
      kronos.source.divergence="LOCAL DIVERGENCE markers in model/kronos.py (ensemble samples)" \
      kronos.model.name="NeoQuasar/Kronos-base" \
      kronos.model.revision="2b554741eca47781b64468546e77fef3e85130e6" \
      kronos.tokenizer.revision="0e0117387f39004a9016484a186a908917e22426"

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Probe the IPv4 loopback: uvicorn listens on 0.0.0.0 only, and the loopback name
# can resolve to ::1. Loading the model takes several minutes on CPU, during which
# /health/ready answers 503, hence the long start period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready')" || exit 1

CMD ["uvicorn", "kronos_api.main:create_app", "--host", "0.0.0.0", "--port", "8000", "--factory"]
