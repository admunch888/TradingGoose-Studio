import re
from pathlib import Path


DOCKERFILE = Path(__file__).parents[1] / "Dockerfile"
CONFIG = Path(__file__).parents[1] / "src" / "kronos_api" / "config.py"


def config_default(name: str) -> str:
    match = re.search(rf'^\s*{name}: str = "([^"]+)"', CONFIG.read_text(), re.MULTILINE)
    assert match, f"{name} default not found in config.py"
    return match.group(1)


def test_weights_are_fetched_at_build_time_not_copied_from_the_context() -> None:
    text = DOCKERFILE.read_text()

    assert "COPY models/" not in text
    assert f"COPY --from=weights /models/kronos-base {config_default('model_path')}" in text
    assert (
        f"COPY --from=weights /models/kronos-tokenizer-base {config_default('tokenizer_path')}"
        in text
    )


def test_pinned_weight_revisions_match_runtime_settings() -> None:
    text = DOCKERFILE.read_text()

    assert f"ARG KRONOS_MODEL_REVISION={config_default('model_revision')}" in text
    assert f"ARG KRONOS_TOKENIZER_REVISION={config_default('tokenizer_revision')}" in text


def test_healthcheck_probes_the_ipv4_loopback() -> None:
    text = DOCKERFILE.read_text()

    assert "http://127.0.0.1:8000/health/ready" in text
    assert "localhost" not in text


def test_runtime_pythonpath_includes_app_and_vendored_model() -> None:
    text = DOCKERFILE.read_text()
    pythonpath_line = next(
        line for line in text.splitlines() if line.startswith("ENV PYTHONPATH=")
    )

    assert "/app/src" in pythonpath_line
    assert "/app/third_party/kronos" in pythonpath_line


def test_cpu_pytorch_index_has_priority_without_unsafe_resolution() -> None:
    text = DOCKERFILE.read_text()
    install_line = next(
        line for line in text.splitlines() if line.startswith("RUN uv pip install")
    )

    assert "--index https://download.pytorch.org/whl/cpu" in install_line
    assert "--default-index https://pypi.org/simple" in install_line
    assert "unsafe-best-match" not in text
