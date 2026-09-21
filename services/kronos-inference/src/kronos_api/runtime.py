import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pandas as pd

from kronos_api.config import Settings
from kronos_api.ensemble import SAMPLE_FIELDS, direction_agreement, summarise_samples
from kronos_api.schemas import ForecastEnsemble, ForecastRequest


@dataclass(frozen=True)
class Prediction:
    """What one `predict` call produces: the path callers read, plus the ensemble summary.

    The agreement summary rides out alongside the points because `main` only ever sees the
    points - the sampled array it was computed from is gone by then - and because it is one
    fact about the whole ensemble rather than a property of any single point.

    `ensemble` is None for a single sample, which is what keeps the wire field absent.
    """

    points: list[dict[str, Any]]
    ensemble: ForecastEnsemble | None = None


def _build_point(timestamp: datetime, values: dict[str, float]) -> dict[str, Any]:
    """Shape one forecast bar, shared by the single-sample and ensemble paths."""
    floats = [float(values[field]) for field in SAMPLE_FIELDS]
    if not all(math.isfinite(value) for value in floats):
        raise RuntimeError("Kronos returned non-finite forecast values")
    return {
        "timestamp": timestamp.to_pydatetime(),
        "open": float(values["open"]),
        "high": float(values["high"]),
        "low": float(values["low"]),
        "close": float(values["close"]),
        # Traded size is never negative, and nothing in the model enforces that.
        "volume": max(0.0, float(values["volume"])),
        "amount": max(0.0, float(values["amount"])),
    }


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
        from model import Kronos, KronosPredictor, KronosTokenizer

        tokenizer = KronosTokenizer.from_pretrained(self.settings.tokenizer_path)
        model = Kronos.from_pretrained(self.settings.model_path)
        tokenizer.eval()
        model.eval()
        self._predictor = KronosPredictor(
            model,
            tokenizer,
            device=self.settings.device,
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

    def predict(self, request: ForecastRequest) -> Prediction:
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

        sample_count = request.parameters.sample_count
        paths: list[dict[str, Any]]
        bands: list[dict[str, Any]] = []
        ensemble: ForecastEnsemble | None = None
        if sample_count == 1:
            # One sample is the call this service has always made: the model's own single
            # path, whose frame is already what the response wants.
            predicted = self._predictor.predict(
                df=frame,
                x_timestamp=historical_local,
                y_timestamp=future_local,
                pred_len=len(future_local),
                T=request.parameters.temperature,
                top_p=request.parameters.top_p,
                sample_count=sample_count,
                verbose=False,
            )
            paths = [
                {field: getattr(row, field) for field in SAMPLE_FIELDS}
                for row in predicted.itertuples(index=False)
            ]
        else:
            # Above one sample, ask for the sampled paths rather than the single averaged
            # one upstream would return, so the spread is still available to report.
            # The samples are replicated through the batch dimension inside the model, so
            # this costs about `sample_count` times the one-sample call.
            samples = self._predictor.predict(
                df=frame,
                x_timestamp=historical_local,
                y_timestamp=future_local,
                pred_len=len(future_local),
                T=request.parameters.temperature,
                top_p=request.parameters.top_p,
                sample_count=sample_count,
                verbose=False,
                return_samples=True,
            )
            paths, bands = summarise_samples(samples)
            # The count comes off the array rather than off the request: the two are the same
            # number today (the model returns one path per requested sample), but if a future
            # predictor ever returned fewer, the wire would report what was actually reduced
            # next to the median and band it was reduced with, not what was asked for.
            ensemble = ForecastEnsemble(
                sample_count=int(samples.shape[0]),
                share_up=direction_agreement(samples, float(request.history[-1].close)),
            )

        points: list[dict[str, Any]] = []
        for index, (timestamp, values) in enumerate(zip(future, paths)):
            point = _build_point(timestamp, values)
            if bands:
                # Absent at one sample (see summarise_samples): an omitted band says "no
                # uncertainty estimate", a zero-width one would claim certainty.
                point["band"] = bands[index]
            points.append(point)
        return Prediction(points=points, ensemble=ensemble)
