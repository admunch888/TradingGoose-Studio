import numpy as np
import pytest

from kronos_api.ensemble import SAMPLE_FIELDS, summarise_samples

CLOSE_COLUMN = SAMPLE_FIELDS.index("close")


def sampled(*close_paths: list[float]) -> np.ndarray:
    """Samples whose closes are the given paths, other fields zero.

    `(sample_count, pred_len, features)` - one complete path per sample, the shape
    the model's decoder produces before upstream averages the sample axis away.
    """
    samples = np.zeros((len(close_paths), len(close_paths[0]), len(SAMPLE_FIELDS)))
    samples[:, :, CLOSE_COLUMN] = np.array(close_paths, dtype=float)
    return samples


def test_median_path_ignores_an_outlier_that_a_mean_would_follow():
    samples = sampled([10.0, 11.0], [20.0, 21.0], [1000.0, 1001.0])

    points, _ = summarise_samples(samples)

    assert [point["close"] for point in points] == [20.0, 21.0]
    # What the ensemble would have reported if it averaged: one wild sample moves the
    # answer by more than an order of magnitude.
    assert samples[:, :, CLOSE_COLUMN].mean(axis=0)[0] == pytest.approx(343.33, abs=0.01)


def test_median_is_taken_per_field_at_each_step():
    bases = np.array([100.0, 110.0, 90.0, 105.0, 1000.0, 10_000.0])
    samples = np.stack(
        [
            np.stack([bases + 0.0, bases + 0.0]),
            np.stack([bases + 1.0, bases + 2.0]),
            np.stack([bases + 5.0, bases + 9.0]),
        ]
    )

    points, bands = summarise_samples(samples)

    assert [point["open"] for point in points] == [101.0, 102.0]
    assert points[0] == {
        "open": 101.0,
        "high": 111.0,
        "low": 91.0,
        "close": 106.0,
        "volume": 1001.0,
        "amount": 10_001.0,
    }
    assert points[1] == {
        "open": 102.0,
        "high": 112.0,
        "low": 92.0,
        "close": 107.0,
        "volume": 1002.0,
        "amount": 10_002.0,
    }
    assert len(bands) == 2


def test_band_is_the_tenth_and_ninetieth_percentile_of_closes_per_step():
    # Ten samples of two steps each: step 0 closes are 1..10, step 1 closes are 2..20.
    paths = [[float(value), float(value * 2)] for value in range(1, 11)]
    samples = sampled(*paths)

    points, bands = summarise_samples(samples)

    assert [point["close"] for point in points] == [5.5, 11.0]
    # numpy interpolates between neighbouring order statistics: p10 of 1..10 falls
    # a tenth of the way from 1 to 2, p90 nine tenths of the way from 9 to 10.
    assert bands[0]["low"] == pytest.approx(1.9)
    assert bands[0]["high"] == pytest.approx(9.1)
    assert bands[1]["low"] == pytest.approx(3.8)
    assert bands[1]["high"] == pytest.approx(18.2)


def test_band_contains_the_median_close_even_when_samples_disagree_wildly():
    samples = sampled(
        [100.0, 100.0],
        [101.0, 90.0],
        [102.0, 130.0],
        [103.0, 95.0],
        [104.0, 99.0],
    )

    points, bands = summarise_samples(samples)

    for point, band in zip(points, bands):
        assert band["low"] <= point["close"] <= band["high"]
    # Step 1's samples disagree, so its band is the wider one.
    assert bands[1]["high"] - bands[1]["low"] > bands[0]["high"] - bands[0]["low"]


def test_single_sample_returns_the_path_itself_and_no_band():
    samples = sampled([10.0, 12.0, 11.0])

    points, bands = summarise_samples(samples)

    assert [point["close"] for point in points] == [10.0, 12.0, 11.0]
    # A zero-width band would read as a real result, so there is none at all.
    assert bands == []


@pytest.mark.parametrize(
    "shape",
    [
        (2, 3),  # not 3-D
        (2, 3, 5),  # one feature short
        (2, 3, 7),  # one feature too many
        (0, 3, 6),  # no samples
        (2, 0, 6),  # no steps
    ],
)
def test_shape_guards_reject_arrays_that_cannot_be_reduced(shape):
    with pytest.raises(ValueError):
        summarise_samples(np.zeros(shape))
