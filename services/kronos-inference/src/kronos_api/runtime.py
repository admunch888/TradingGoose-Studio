import math
from typing import Any

import pandas as pd

from kronos_api.config import Settings
from kronos_api.schemas import ForecastRequest

CUDA_INDEX_HINT = "https://download.pytorch.org/whl/cu128"


class DeviceUnavailableError(RuntimeError):
    """The configured KRONOS_DEVICE cannot be used by this image on this host."""


def resolve_device(requested: str, torch_module: Any) -> str:
    """
    Check that the configured device can actually run the model, and say what is
    missing when it cannot.

    A GPU only works when three things line up: the image was built from a CUDA
    wheel index, the host driver and NVIDIA container toolkit are installed, and
    the container was given the device. Each of those fails differently and none
    of them fails where the operator is looking, so they get separate messages
    here rather than a `RuntimeError: No CUDA GPUs are available` from deep
    inside the first forward pass.
    """
    device = requested.strip().lower()

    if device == "cpu":
        return device

    if device == "mps":
        backend = getattr(torch_module.backends, "mps", None)
        if backend is None or not backend.is_available():
            raise DeviceUnavailableError(
                "KRONOS_DEVICE is mps, but this PyTorch build has no Metal backend."
            )
        return device

    if device == "cuda" or device.startswith("cuda:"):
        if torch_module.version.cuda is None:
            raise DeviceUnavailableError(
                f"KRONOS_DEVICE is {requested}, but this image was built from the CPU "
                "PyTorch index and has no CUDA runtime. Rebuild it with "
                f"--build-arg TORCH_INDEX_URL={CUDA_INDEX_HINT}."
            )
        if not torch_module.cuda.is_available():
            raise DeviceUnavailableError(
                f"KRONOS_DEVICE is {requested}, and this image has CUDA "
                f"{torch_module.version.cuda}, but no GPU is visible inside the "
                "container. Check the host driver (nvidia-smi), the NVIDIA "
                "Container Toolkit, and that the container was given the device "
                "(devices: [nvidia.com/gpu=all])."
            )
        return device

    raise DeviceUnavailableError(
        f"KRONOS_DEVICE must be cpu, cuda, cuda:<index> or mps, not {requested!r}."
    )


class KronosRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.ready = False
        self._predictor = None
        self.metadata = {
            "name": settings.model_name,
            "sourceRevision": settings.source_revision,
            "modelRevision": settings.model_revision,
            "tokenizerRevision": settings.tokenizer_revision,
            "device": settings.device,
            "maxContext": settings.max_context,
        }

    def load(self) -> None:
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer

        # Before the weights are read, so a misconfigured device fails startup with
        # its own message instead of a CUDA error minutes into loading.
        device = resolve_device(self.settings.device, torch)
        self.metadata["device"] = device

        tokenizer = KronosTokenizer.from_pretrained(self.settings.tokenizer_path)
        model = Kronos.from_pretrained(self.settings.model_path)
        tokenizer.eval()
        model.eval()
        self._predictor = KronosPredictor(
            model,
            tokenizer,
            device=device,
            max_context=self.settings.max_context,
        )
        if self.settings.warmup:
            self._warmup()
        self.ready = True

    def _warmup(self) -> None:
        start = pd.Timestamp("2026-01-02T09:30:00", tz="America/New_York")
        timestamps = pd.Series(pd.date_range(start=start, periods=32, freq="5min"))
        future = pd.Series([timestamps.iloc[-1] + pd.Timedelta(minutes=5)])
        values = [100.0 + index * 0.1 for index in range(32)]
        frame = pd.DataFrame(
            {
                "open": values,
                "high": [value + 0.2 for value in values],
                "low": [value - 0.2 for value in values],
                "close": [value + 0.1 for value in values],
                "volume": [1000.0] * 32,
            }
        )
        self._predictor.predict(
            df=frame,
            x_timestamp=timestamps,
            y_timestamp=future,
            pred_len=1,
            T=1.0,
            top_p=0.9,
            sample_count=1,
            verbose=False,
        )

    def predict(self, request: ForecastRequest) -> list[dict[str, Any]]:
        if not self.ready or self._predictor is None:
            raise RuntimeError("Kronos model is not ready")

        records: dict[str, list[float]] = {
            "open": [bar.open for bar in request.history],
            "high": [bar.high for bar in request.history],
            "low": [bar.low for bar in request.history],
            "close": [bar.close for bar in request.history],
        }
        if request.history[0].volume is not None:
            records["volume"] = [float(bar.volume) for bar in request.history]
        if request.history[0].amount is not None:
            records["amount"] = [float(bar.amount) for bar in request.history]

        frame = pd.DataFrame(records)
        historical = pd.Series(pd.to_datetime([bar.timestamp for bar in request.history], utc=True))
        future = pd.Series(pd.to_datetime(request.future_timestamps, utc=True))
        historical_local = historical.dt.tz_convert(request.timezone)
        future_local = future.dt.tz_convert(request.timezone)

        predicted = self._predictor.predict(
            df=frame,
            x_timestamp=historical_local,
            y_timestamp=future_local,
            pred_len=len(future_local),
            T=request.parameters.temperature,
            top_p=request.parameters.top_p,
            sample_count=request.parameters.sample_count,
            verbose=False,
        )

        points: list[dict[str, Any]] = []
        for timestamp, row in zip(future, predicted.itertuples(index=False)):
            values = [row.open, row.high, row.low, row.close, row.volume, row.amount]
            if not all(math.isfinite(float(value)) for value in values):
                raise RuntimeError("Kronos returned non-finite forecast values")
            points.append(
                {
                    "timestamp": timestamp.to_pydatetime(),
                    "open": float(row.open),
                    "high": float(row.high),
                    "low": float(row.low),
                    "close": float(row.close),
                    "volume": max(0.0, float(row.volume)),
                    "amount": max(0.0, float(row.amount)),
                }
            )
        return points
