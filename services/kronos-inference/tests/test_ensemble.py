import numpy as np
import pytest

from kronos_api.ensemble import SAMPLE_FIELDS, direction_agreement, summarise_samples

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


def test_summarise_samples_still_returns_the_path_and_band_pair():
    # The service's only other reduction is built next to this one, and callers destructure
    # exactly two values out of it: a third return value here would break every one of them.
    samples = sampled([100.0, 101.0], [99.0, 98.0])

    result = summarise_samples(samples)

    assert isinstance(result, tuple)
    assert len(result) == 2
    points, bands = result
    # One entry per step in each half of the pair.
    assert len(points) == len(bands) == 2


def direction_samples(*final_closes: float) -> np.ndarray:
    """One two-step path per sample, ending at the given close."""
    samples = np.zeros((len(final_closes), 2, len(SAMPLE_FIELDS)))
    samples[:, :, CLOSE_COLUMN] = np.array([[close - 1.0, close] for close in final_closes])
    return samples


def test_all_samples_above_the_anchor_agree_completely():
    share = direction_agreement(direction_samples(101.0, 102.0, 103.0, 104.0), 100.0)

    assert share == 1.0


def test_no_sample_above_the_anchor_agrees_not_at_all():
    share = direction_agreement(direction_samples(99.0, 98.0, 97.0, 96.0), 100.0)

    assert share == 0.0


def test_share_is_the_count_of_up_samples_over_all_samples():
    # Three of four end higher; the path that got there does not matter, only the last step.
    share = direction_agreement(direction_samples(103.0, 101.0, 99.0, 108.0), 100.0)

    assert share == pytest.approx(0.75)


def test_a_sample_closing_exactly_at_the_anchor_is_not_up():
    # Unchanged is not a direction: a rule that asks for a majority up must not be satisfied
    # by samples that went nowhere.
    share = direction_agreement(direction_samples(100.0, 101.0), 100.0)

    assert share == pytest.approx(0.5)


def test_only_the_terminal_step_is_compared_to_the_anchor():
    # Every path crosses the anchor on the way, and only the last close decides the count.
    samples = direction_samples(99.0, 101.0)
    samples[:, 0, CLOSE_COLUMN] = [120.0, 60.0]

    share = direction_agreement(samples, 100.0)

    assert share == pytest.approx(0.5)


def test_a_single_sample_reports_whether_its_one_path_is_up():
    # Not a special case to omit here - the runtime is what drops the summary at one sample,
    # so that the endpoint can say "no agreement to report" rather than "100% agreed".
    assert direction_agreement(direction_samples(105.0), 100.0) == 1.0
    assert direction_agreement(direction_samples(95.0), 100.0) == 0.0


@pytest.mark.parametrize(
    "shape",
    [
        (2, 3),  # not 3-D
        (2, 3, 5),  # one feature short
        (2, 3, 7),  # one feature too many
        (0, 3, 6),  # no samples, so nothing to count
        (2, 0, 6),  # no steps, so no terminal close to compare
    ],
)
def test_agreement_guards_reject_arrays_that_cannot_be_counted(shape):
    with pytest.raises(ValueError):
        direction_agreement(np.zeros(shape), 100.0)
