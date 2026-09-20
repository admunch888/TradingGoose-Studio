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
| `KRONOS_MAX_SAMPLES` | `16` | Largest `parameters.sampleCount` accepted. Higher requests are refused, not clamped. |
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

## Sampling and uncertainty

`POST /v1/forecast` accepts `parameters.sampleCount` (default `1`, largest accepted value is `KRONOS_MAX_SAMPLES`, default `16`). A request above the cap is refused with 422 rather than clamped, because the sample count is what the caller is paying for.

- `sampleCount = 1` is a single forecast: one path, and every `forecast` point carries `open`, `high`, `low`, `close`, `volume`, `amount`.
- `sampleCount > 1` runs that many independent sampled paths, and each `forecast` point becomes the **median** of the samples at that step, field by field. The median rather than the mean, so that one wild sample does not move the path.
- Each point then also carries `band: { low, high }`: the 10th and 90th percentile of the sampled closes at that step, taken across samples at the same step. The band is **omitted when `sampleCount = 1`**, because a one-sample band is zero-width and would read as a real, confident result. A caller that sees no `band` should report "no uncertainty estimate" rather than zero width.
- `band.high` and `band.low` are the raw percentiles of the sampled closes, so they are not widened by the candle reconciliation that keeps each point's `high >= max(open, close)`. The median close always lies inside the band.
- Cost is linear in `sampleCount`: the samples are replicated through the batch dimension of a single inference, so 16 samples take roughly 16x the time and memory of one. Raise `KRONOS_MAX_SAMPLES` with that in mind.

## Vendored model

`third_party/kronos/` is a copy of [Kronos](https://github.com/shiyu-coder/Kronos) at the revision recorded in `third_party/kronos/UPSTREAM_REVISION`. `model/kronos.py` carries one local patch, marked with `LOCAL DIVERGENCE` comments: `KronosPredictor.predict(..., return_samples=True)` returns the per-sample array instead of the average upstream computes, which is what the band is built from. Every other caller, including `predict_batch`, takes the default and behaves exactly as upstream.

## Tests

```bash
cd services/kronos-inference
uv run --group dev pytest
```
