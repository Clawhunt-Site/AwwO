import pytest

from superclaw.verifier import VerificationExpressionError, evaluate_expression


def test_verifier_supports_boolean_metrics_and_comparisons():
    metrics = {"keyword_count": 72, "demands_recorded": True, "status": "ok"}

    assert evaluate_expression("keyword_count >= 50", metrics) is True
    assert evaluate_expression("demands_recorded", metrics) is True
    assert evaluate_expression("status == ok", metrics) is True
    assert evaluate_expression("keyword_count < 10", metrics) is False


def test_verifier_supports_and_chains_fail_closed():
    metrics = {"health_reachable": True, "upstream_ok": False}

    assert evaluate_expression("health_reachable and upstream_ok", metrics) is False
    assert evaluate_expression("missing_metric", metrics) is False


def test_verifier_rejects_unsupported_expression_shape():
    with pytest.raises(VerificationExpressionError):
        evaluate_expression("__import__('os').system('echo bad')", {})

