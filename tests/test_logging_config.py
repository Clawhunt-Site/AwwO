"""Root logging configuration: idempotency, env knobs, JSON output, redaction."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from superclaw import logging_config as lc


@pytest.fixture
def clean_superclaw_logger():
    """Snapshot + restore the global ``superclaw`` logger around each test."""
    logger = logging.getLogger("superclaw")
    saved_handlers = list(logger.handlers)
    saved_level = logger.level
    saved_propagate = logger.propagate
    saved_flag = getattr(logger, lc._CONFIGURED_FLAG, False)
    try:
        yield logger
    finally:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
        for handler in saved_handlers:
            logger.addHandler(handler)
        logger.setLevel(saved_level)
        logger.propagate = saved_propagate
        if saved_flag:
            setattr(logger, lc._CONFIGURED_FLAG, saved_flag)
        elif hasattr(logger, lc._CONFIGURED_FLAG):
            delattr(logger, lc._CONFIGURED_FLAG)


def _managed_handlers(logger: logging.Logger) -> list[logging.Handler]:
    return [h for h in logger.handlers if getattr(h, lc._MANAGED_HANDLER_FLAG, False)]


def test_configure_is_idempotent(clean_superclaw_logger, monkeypatch) -> None:
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)
    first = len(_managed_handlers(clean_superclaw_logger))
    lc.configure_logging()  # no force -> no-op
    lc.configure_logging()
    assert len(_managed_handlers(clean_superclaw_logger)) == first == 1


def test_force_reconfig_replaces_not_appends(clean_superclaw_logger, monkeypatch) -> None:
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)
    lc.configure_logging(force=True)
    # Re-config must drop the prior managed handler, not stack a second one.
    assert len(_managed_handlers(clean_superclaw_logger)) == 1


def test_level_from_env(clean_superclaw_logger, monkeypatch) -> None:
    monkeypatch.setenv(lc.LOG_LEVEL_ENV, "DEBUG")
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.level == logging.DEBUG


def test_invalid_level_falls_back_to_info(clean_superclaw_logger, monkeypatch) -> None:
    monkeypatch.setenv(lc.LOG_LEVEL_ENV, "NONSENSE")
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.level == logging.INFO


def test_propagate_defaults_false_for_safety(clean_superclaw_logger, monkeypatch) -> None:
    # Production default: never bubble superclaw.* records to a root handler we
    # don't control (would bypass redaction). Delete the env to assert the real
    # default regardless of ambient configuration.
    monkeypatch.delenv(lc.LOG_PROPAGATE_ENV, raising=False)
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.propagate is False


def test_propagate_env_opt_in(clean_superclaw_logger, monkeypatch) -> None:
    monkeypatch.setenv(lc.LOG_PROPAGATE_ENV, "true")
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.propagate is True
    monkeypatch.setenv(lc.LOG_PROPAGATE_ENV, "false")
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.propagate is False


def test_force_reconfig_closes_old_handlers(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    # Regression: force=True must close (not just remove) old file handlers, or
    # the rotating file descriptor leaks across reconfigurations.
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(tmp_path / "fd.log"))
    lc.configure_logging(force=True)
    old_file_handlers = [h for h in _managed_handlers(clean_superclaw_logger)
                         if isinstance(h, lc.SecureRotatingFileHandler)]
    assert old_file_handlers
    lc.configure_logging(force=True)
    for handler in old_file_handlers:
        assert handler.stream is None  # closed -> stream released


def test_propagated_exception_is_redacted_for_root_and_caplog(clean_superclaw_logger, monkeypatch) -> None:
    # The propagation leak Codex/agy flagged: a root handler re-rendering the
    # raw exc_info would leak. Record-level redaction must have cleared exc_info
    # and frozen redacted exc_text BEFORE the record reaches a root handler.
    monkeypatch.setenv(lc.LOG_PROPAGATE_ENV, "true")
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)

    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    root = logging.getLogger()
    sink = _Capture()
    root.addHandler(sink)
    try:
        secret = "ghp_" + "d" * 20
        try:
            raise ValueError(f"boom {secret}")
        except ValueError:
            lc.get_logger("test.leak").exception("propagated")
    finally:
        root.removeHandler(sink)

    assert captured, "record did not propagate to the root handler"
    record = captured[-1]
    assert record.exc_info is None  # raw traceback cleared before propagation
    assert secret not in (record.exc_text or "")
    assert "[REDACTED]" in (record.exc_text or "")
    # And a foreign root formatter rendering it cannot resurrect the secret.
    rendered = logging.Formatter("%(message)s").format(record)
    assert secret not in rendered


def test_extra_string_fields_are_redacted_on_record(clean_superclaw_logger, monkeypatch) -> None:
    # Codex follow-up: caller-provided extra= fields must be redacted on the
    # record so a foreign/root handler rendering them cannot leak.
    monkeypatch.setenv(lc.LOG_PROPAGATE_ENV, "true")
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)

    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    root = logging.getLogger()
    sink = _Capture()
    root.addHandler(sink)
    try:
        secret = "AKIAIOSFODNN7EXAMPLE"
        lc.get_logger("test.extra").info("op done", extra={"detail": f"key={secret}"})
    finally:
        root.removeHandler(sink)

    assert captured
    detail = captured[-1].__dict__["detail"]
    assert secret not in detail
    assert "[REDACTED]" in detail


def test_container_extra_not_bubbled_under_default_propagate(clean_superclaw_logger, monkeypatch) -> None:
    # Honest contract: nested-container extra is NOT redacted, so the standing
    # guard is propagate=False (the default) — such a record must never reach an
    # uncontrolled root handler at all.
    monkeypatch.delenv(lc.LOG_PROPAGATE_ENV, raising=False)
    monkeypatch.delenv(lc.LOG_FILE_ENV, raising=False)
    lc.configure_logging(force=True)
    assert clean_superclaw_logger.propagate is False

    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    root = logging.getLogger()
    sink = _Capture()
    root.addHandler(sink)
    try:
        lc.get_logger("test.container").info(
            "op", extra={"payload": {"token": "ghp_" + "e" * 20}}
        )
    finally:
        root.removeHandler(sink)

    assert captured == []  # default propagate=False keeps it off the root handler


def test_filter_survives_object_with_raising_str(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    # A custom object whose __str__ raises a non-(Type/Value/Key/Index) error
    # must not crash the caller's logging call.
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(tmp_path / "bad.log"))
    lc.configure_logging(force=True)

    class _Bad:
        def __str__(self) -> str:
            raise AttributeError("no str for you")

    lc.get_logger("test.bad").info("value=%s", _Bad())  # must not raise
    for handler in clean_superclaw_logger.handlers:
        handler.flush()
    assert "[log-redaction-error]" in (tmp_path / "bad.log").read_text(encoding="utf-8")


def test_rotation_keeps_files_0600(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "rot.log"
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    monkeypatch.setenv(lc.LOG_FILE_MAX_BYTES_ENV, "200")
    monkeypatch.setenv(lc.LOG_FILE_BACKUPS_ENV, "2")
    lc.configure_logging(force=True)

    logger = lc.get_logger("test.rot")
    for _ in range(50):
        logger.info("x" * 50)
    for handler in clean_superclaw_logger.handlers:
        handler.flush()

    rotated = list(tmp_path.glob("rot.log*"))
    assert len(rotated) >= 2  # rollover actually happened
    for path in rotated:
        assert (path.stat().st_mode & 0o777) == 0o600, path


def test_stack_info_rendered_in_json(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "stack.json"
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "json")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)
    lc.get_logger("test.stack").info("with stack", stack_info=True)
    for handler in clean_superclaw_logger.handlers:
        handler.flush()
    record = json.loads(log_file.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert "stack" in record


def test_json_format_emits_parseable_json(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "out.log"
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "json")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)

    lc.get_logger("test.json").warning("hello world")
    for handler in clean_superclaw_logger.handlers:
        handler.flush()

    line = log_file.read_text(encoding="utf-8").strip().splitlines()[-1]
    record = json.loads(line)
    assert record["level"] == "WARNING"
    assert record["logger"] == "superclaw.test.json"
    assert record["msg"] == "hello world"
    assert record["ts"].endswith("Z")


def test_secret_is_redacted_in_output(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "out.log"
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "text")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)

    secret = "sk-proj-" + "a" * 48
    lc.get_logger("test.redact").error("leaking token=%s now", secret)
    for handler in clean_superclaw_logger.handlers:
        handler.flush()

    contents = log_file.read_text(encoding="utf-8")
    assert secret not in contents
    assert "[REDACTED]" in contents


def test_exception_traceback_is_redacted_text(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "exc.log"
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "text")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)

    secret = "ghp_" + "c" * 20
    try:
        raise ValueError(f"boom token={secret}")
    except ValueError:
        lc.get_logger("test.exc").exception("handler failed")
    for handler in clean_superclaw_logger.handlers:
        handler.flush()

    contents = log_file.read_text(encoding="utf-8")
    assert secret not in contents  # traceback text must be scrubbed
    assert "[REDACTED]" in contents
    assert "ValueError" in contents  # but the traceback itself survives


def test_exception_redacted_and_json_still_valid(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "exc.json"
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "json")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)

    secret = "sk-ant-api03-" + "A1b2" * 12
    try:
        raise RuntimeError(f"fail {secret}")
    except RuntimeError:
        lc.get_logger("test.excjson").exception("oops")
    for handler in clean_superclaw_logger.handlers:
        handler.flush()

    line = log_file.read_text(encoding="utf-8").strip().splitlines()[-1]
    assert secret not in line
    record = json.loads(line)  # redaction must not break JSON validity
    assert "[REDACTED]" in record["exc"]


def test_log_file_is_chmod_0600(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    log_file = tmp_path / "secure.log"
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(log_file))
    lc.configure_logging(force=True)
    lc.get_logger("test.perms").info("touch")
    mode = log_file.stat().st_mode & 0o777
    assert mode == 0o600


def test_managed_handler_redacts_with_foreign_handler_present(clean_superclaw_logger, monkeypatch, tmp_path: Path) -> None:
    # Honest boundary (Codex follow-up): configure_logging leaves foreign handlers
    # untouched. The guarantee we DO make is that the managed handler's output is
    # redacted. In THIS test's add order the foreign handler runs after the managed
    # one (so it happens to see the already-redacted record) — not a general
    # guarantee. The docstring is explicit that a foreign handler on the superclaw
    # logger is the caller's responsibility.
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(tmp_path / "managed.log"))
    lc.configure_logging(force=True)

    foreign_seen: list[str] = []

    class _Foreign(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            foreign_seen.append(record.getMessage())

    foreign = _Foreign()
    logging.getLogger("superclaw").addHandler(foreign)
    try:
        secret = "ghp_" + "f" * 20
        lc.get_logger("test.foreign").warning("k=%s", secret)
    finally:
        logging.getLogger("superclaw").removeHandler(foreign)

    contents = (tmp_path / "managed.log").read_text(encoding="utf-8")
    assert secret not in contents  # managed handler output redacted (guaranteed)
    assert "[REDACTED]" in contents


def test_get_logger_namespaces() -> None:
    assert lc.get_logger("foo").name == "superclaw.foo"
    assert lc.get_logger("superclaw").name == "superclaw"
    assert lc.get_logger("superclaw.bar").name == "superclaw.bar"


def test_redacting_filter_unit() -> None:
    flt = lc.SecretRedactingFilter()
    record = logging.LogRecord(
        name="superclaw.x", level=logging.INFO, pathname=__file__, lineno=1,
        msg="key=%s", args=("ghp_" + "b" * 20,), exc_info=None,
    )
    assert flt.filter(record) is True
    assert "ghp_" not in record.getMessage()
    assert "[REDACTED]" in record.getMessage()
    assert record.args == ()


def test_json_formatter_surfaces_trace_fields_when_present() -> None:
    """Forward-compat with the trace-context commit: fields render if set."""
    fmt = lc.JsonLogFormatter()
    record = logging.LogRecord(
        name="superclaw.x", level=logging.INFO, pathname=__file__, lineno=1,
        msg="hi", args=(), exc_info=None,
    )
    record.trace_id = "trace_abc"
    record.run_id = "run_123"
    payload = json.loads(fmt.format(record))
    assert payload["trace_id"] == "trace_abc"
    assert payload["run_id"] == "run_123"
    # Unset trace fields must not appear.
    assert "span_id" not in payload
