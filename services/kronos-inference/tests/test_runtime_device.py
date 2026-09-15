"""
`KRONOS_DEVICE=cuda` only works when the image, the host and the container all
agree. These cover each way that agreement breaks, because the operator sees the
message and nothing else: the container exits during startup, so there is no
`/health/ready` to ask and no forecast to trace back.
"""

from types import SimpleNamespace

import pytest

from kronos_api.runtime import DeviceUnavailableError, resolve_device


def fake_torch(*, cuda_build: str | None, gpu_visible: bool, mps: bool = False) -> SimpleNamespace:
    """Stands in for the parts of `torch` that `resolve_device` reads."""
    return SimpleNamespace(
        version=SimpleNamespace(cuda=cuda_build),
        cuda=SimpleNamespace(is_available=lambda: gpu_visible),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
    )


CPU_IMAGE = fake_torch(cuda_build=None, gpu_visible=False)
GPU_IMAGE_NO_DEVICE = fake_torch(cuda_build="12.8", gpu_visible=False)
GPU_IMAGE_READY = fake_torch(cuda_build="12.8", gpu_visible=True)


def test_cpu_needs_nothing_from_the_host() -> None:
    assert resolve_device("cpu", CPU_IMAGE) == "cpu"


@pytest.mark.parametrize("requested", ["cuda", "cuda:0", "CUDA", " cuda "])
def test_cuda_is_accepted_once_the_image_and_the_gpu_are_both_there(requested: str) -> None:
    assert resolve_device(requested, GPU_IMAGE_READY) == requested.strip().lower()


def test_cpu_only_image_points_at_the_build_argument() -> None:
    with pytest.raises(DeviceUnavailableError) as error:
        resolve_device("cuda", CPU_IMAGE)

    # The fix is a rebuild, not a host change, so the message has to name the arg.
    assert "TORCH_INDEX_URL" in str(error.value)
    assert "nvidia-smi" not in str(error.value)


def test_gpu_image_without_a_visible_device_points_at_the_host() -> None:
    with pytest.raises(DeviceUnavailableError) as error:
        resolve_device("cuda", GPU_IMAGE_NO_DEVICE)

    # Here the image is right and the rebuild would waste half an hour.
    assert "TORCH_INDEX_URL" not in str(error.value)
    assert "nvidia.com/gpu=all" in str(error.value)


def test_mps_is_rejected_on_a_build_without_the_metal_backend() -> None:
    with pytest.raises(DeviceUnavailableError):
        resolve_device("mps", CPU_IMAGE)


def test_mps_is_accepted_when_the_backend_is_available() -> None:
    assert resolve_device("mps", fake_torch(cuda_build=None, gpu_visible=False, mps=True)) == "mps"


def test_an_unknown_device_is_named_back() -> None:
    with pytest.raises(DeviceUnavailableError) as error:
        resolve_device("gpu", GPU_IMAGE_READY)

    assert "'gpu'" in str(error.value)
