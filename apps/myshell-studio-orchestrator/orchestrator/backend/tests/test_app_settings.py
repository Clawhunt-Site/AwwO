from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.settings import DEFAULT_CORS_ALLOW_ORIGINS, get_settings  # noqa: E402


def test_default_cors_origins_are_local_and_never_wildcard() -> None:
    with patch.dict("os.environ", {}, clear=True):
        settings = get_settings()

    assert settings.cors_allow_origins == DEFAULT_CORS_ALLOW_ORIGINS
    assert "*" not in settings.cors_allow_origins


def test_cors_origins_are_configurable_as_a_comma_separated_list() -> None:
    with patch.dict(
        "os.environ",
        {"STUDIO_CORS_ALLOW_ORIGINS": "https://studio.example, https://preview.example"},
        clear=True,
    ):
        settings = get_settings()

    assert settings.cors_allow_origins == ["https://studio.example", "https://preview.example"]


def test_cors_origins_reject_wildcard_configuration() -> None:
    with patch.dict("os.environ", {"STUDIO_CORS_ALLOW_ORIGINS": "*"}, clear=True):
        with pytest.raises(ValueError, match="explicit origins"):
            get_settings()
