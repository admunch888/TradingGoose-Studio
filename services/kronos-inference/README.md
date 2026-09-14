# Kronos inference service

A private FastAPI service that runs the [Kronos](https://github.com/shiyu-coder/Kronos) foundation model (`NeoQuasar/Kronos-base`) for the **Kronos Forecast** workflow block. The app calls `POST /v1/forecast` with a bearer token. The service never places orders or sees broker credentials.

## Build

The Docker build downloads the pinned model and tokenizer revisions from Hugging Face (about 400 MB), so there is no separate setup step. The runtime image is CPU-only and runs offline (`HF_HUB_OFFLINE=1`).

```bash
docker build -t tradinggoose/kronos-inference:local services/kronos-inference
```

The revisions are build args (`KRONOS_MODEL_REVISION`, `KRONOS_TOKENIZER_REVISION`) and must match the defaults in `src/kronos_api/config.py`. `tests/test_container_packaging.py` checks that they do.

## Run with Docker Compose

1. Generate a token: `openssl rand -hex 32`
2. Add to `.env`:
   ```bash
   KRONOS_ENABLED=true
   KRONOS_API_TOKEN=<token>
   ```
3. Start the stack with the `kronos` profile:
   ```bash
   docker compose -f docker-compose.local.yml --profile kronos up -d --build
   ```

The app reaches the service at `http://kronos:8000`. Loading the model takes a few minutes on CPU. Until `/health/ready` returns 200, forecasts fail with "Kronos service is not ready".

For Kubernetes, build and push the image, then set `kronos.enabled`, `kronos.image`, and `kronos.apiToken` in the Helm chart.

## Configuration

Service (environment prefix `KRONOS_`):

| Variable | Default | Notes |
| --- | --- | --- |
| `KRONOS_API_TOKEN` | required | 32+ characters. The app sends it as `KRONOS_INTERNAL_TOKEN`. |
| `KRONOS_MAX_CONTEXT` | `512` | History bars the model sees. |
| `KRONOS_MAX_QUEUE` | `8` | Requests waiting beyond this get 429. |
| `KRONOS_INFERENCE_CONCURRENCY` | `1` | Parallel inferences. |
| `KRONOS_WARMUP` | `true` | Runs one forecast at startup. |

App:

| Variable | Default | Notes |
| --- | --- | --- |
| `KRONOS_ENABLED` | `false` | The block's route returns 404 unless this, the URL, and the token are all set. |
| `KRONOS_INTERNAL_URL` | none | For example `http://kronos:8000`. |
| `KRONOS_INTERNAL_TOKEN` | none | Same value as the service's `KRONOS_API_TOKEN`. |
| `KRONOS_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `KRONOS_MAX_HORIZON` | `32` | Largest forecast horizon accepted. |

## Endpoints

- `GET /health/live`: the process is up.
- `GET /health/ready`: 200 once the model is loaded, 503 before that.
- `POST /v1/forecast`: needs `Authorization: Bearer <KRONOS_API_TOKEN>`.

## Using the block

- Connect **Market Series** to the Historical Data block's `marketSeries` output, and use the same interval.
- The history must have 32 to 512 bars. The horizon is 1 to 32 bars.
- Forecast timestamps follow the listing's trading calendar, inferred from the history itself:
  - Weekends are skipped unless the history has weekend bars (crypto trades every day).
  - Intraday forecasts stay within the first and last bar times seen in the history. This needs at least two days of intraday bars.
  - Daily and weekly steps keep the bar's local time across DST changes.
  - Exchange holidays and half days are not modelled.

## Tests

```bash
cd services/kronos-inference
uv run --group dev pytest
```
