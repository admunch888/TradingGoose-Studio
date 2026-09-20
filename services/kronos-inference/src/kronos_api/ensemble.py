"""Turning a set of sampled Kronos paths into one path plus an uncertainty band.

Kept free of torch and of the model itself on purpose: the part that decides what
callers actually see - which path they get and how wide the band is - is the part
worth testing, and it should not need weights or a GPU to run.
"""

from typing import Any

import numpy as np

# The feature order KronosPredictor emits (`price_cols + [vol_col, amt_vol]`). The
# reduction is per column, so this order is the only thing tying the array to names.
SAMPLE_FIELDS = ("open", "high", "low", "close", "volume", "amount")
CLOSE_COLUMN = SAMPLE_FIELDS.index("close")

# The band a caller reads as "where the close could plausibly land". p10/p90 rather
# than min/max: with a handful of samples the extremes are one unlucky draw away from
# uselessly wide.
LOW_PERCENTILE = 10.0
HIGH_PERCENTILE = 90.0


def summarise_samples(
    samples: np.ndarray,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Reduce per-sample paths to a median path and a band of sampled closes.

    `samples` is `(sample_count, pred_len, len(SAMPLE_FIELDS))` in price space - one
    complete path per sample, which is exactly what the model produces before
    upstream averages it away.

    The median rather than the mean: these paths are drawn from the same temperature
    sampling, and the cases worth reporting are the ones where a few samples disagree
    with the rest. A mean follows those outliers, a median does not, and the median
    of the sampled closes is also always inside the returned band.

    Returns `(points, bands)`. `bands` is empty for a single sample, because a
    one-sample band is zero-width and would read as a real, confident result - the
    caller should see "no uncertainty estimate", not a line.
    """
    samples = np.asarray(samples, dtype=float)
    if samples.ndim != 3:
        raise ValueError(
            f"expected a 3-D (sample_count, pred_len, features) array, got shape {samples.shape}"
        )
    if samples.shape[2] != len(SAMPLE_FIELDS):
        raise ValueError(
            f"expected {len(SAMPLE_FIELDS)} feature columns {SAMPLE_FIELDS}, got shape {samples.shape}"
        )
    if samples.shape[0] < 1 or samples.shape[1] < 1:
        raise ValueError(f"expected at least one sample and one step, got shape {samples.shape}")

    median = np.median(samples, axis=0)
    points: list[dict[str, Any]] = [
        {field: float(median[step, column]) for column, field in enumerate(SAMPLE_FIELDS)}
        for step in range(median.shape[0])
    ]

    if samples.shape[0] == 1:
        return points, []

    closes = samples[:, :, CLOSE_COLUMN]
    percentiles = np.percentile(closes, [LOW_PERCENTILE, HIGH_PERCENTILE], axis=0)
    bands: list[dict[str, Any]] = [
        {"low": float(percentiles[0, step]), "high": float(percentiles[1, step])}
        for step in range(percentiles.shape[1])
    ]
    return points, bands
