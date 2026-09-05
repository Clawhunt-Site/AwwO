import json
from pathlib import Path

from superclaw.media import (
    RunningHubMediaRenderRequest,
    RunningHubMediaRequest,
    query_runninghub_media_task,
    render_runninghub_media_task,
    runninghub_media_doctor,
    submit_runninghub_media_task,
)


class _FakeRunningHubResponse:
    status_code = 200
    text = ""

    def json(self):
        return {
            "code": 0,
            "msg": "success",
            "data": [
                {
                    "fileUrl": "https://rh-images.example/output/demo.png",
                    "fileType": "png",
                    "nodeId": "12",
                },
                {
                    "fileUrl": "https://rh-images.example/output/demo.png",
                    "fileType": "png",
                    "nodeId": "12",
                },
                {
                    "download_url": "https://rh-images.example/output/demo-video.mp4",
                    "fileType": "mp4",
                    "nodeId": "18",
                },
            ],
        }


class _FakeRunningHubClient:
    def __init__(self):
        self.request_json = None
        self.request_headers = None

    def post(self, _endpoint, *, json, headers):
        self.request_json = json
        self.request_headers = headers
        return _FakeRunningHubResponse()


class _FakePayloadResponse:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeStandardSubmitResponse:
    status_code = 200
    text = ""

    def json(self):
        return {
            "taskId": "task_standard_demo",
            "status": "RUNNING",
            "clientId": "client_standard_demo",
            "results": None,
        }


class _FakeStandardSubmitClient:
    def __init__(self):
        self.endpoint = None
        self.request_json = None
        self.request_headers = None

    def post(self, endpoint, *, json, headers):
        self.endpoint = endpoint
        self.request_json = json
        self.request_headers = headers
        return _FakeStandardSubmitResponse()


class _FakeLegacyRenderRunningHubClient:
    def __init__(self):
        self.calls = []

    def post(self, endpoint, *, json, headers):
        self.calls.append({"endpoint": endpoint, "json": json, "headers": headers})
        if endpoint.endswith("/task/openapi/ai-app/run"):
            return _FakePayloadResponse({"code": 0, "data": {"taskId": "task_render_demo", "taskStatus": "SUBMITTED"}})
        if endpoint.endswith("/task/openapi/status"):
            return _FakePayloadResponse({"code": 0, "data": {"taskId": "task_render_demo", "taskStatus": "SUCCESS"}})
        if endpoint.endswith("/task/openapi/outputs"):
            return _FakePayloadResponse(
                {
                    "code": 0,
                    "data": [
                        {
                            "fileUrl": "https://rh-images.example/output/render.png",
                            "fileType": "png",
                        }
                    ],
                }
            )
        raise AssertionError(f"unexpected endpoint {endpoint}")


class _FakeStandardRenderRunningHubClient:
    def __init__(self):
        self.calls = []

    def post(self, endpoint, *, json, headers):
        self.calls.append({"endpoint": endpoint, "json": json, "headers": headers})
        if endpoint.endswith("/openapi/v2/rhart-image-n-pro/text-to-image"):
            return _FakePayloadResponse({"taskId": "task_render_demo", "status": "RUNNING", "results": None})
        if endpoint.endswith("/openapi/v2/query"):
            return _FakePayloadResponse(
                {
                    "taskId": "task_render_demo",
                    "status": "SUCCESS",
                    "results": [
                        {
                            "url": "https://rh-images.example/output/standard-render.png",
                            "outputType": "png",
                        }
                    ],
                }
            )
        raise AssertionError(f"unexpected endpoint {endpoint}")


class _FakeSkuDetailClient:
    def __init__(self, endpoint_overrides=None):
        self.calls = []
        self.endpoint_overrides = endpoint_overrides or {}

    def post(self, endpoint, *, json):
        self.calls.append({"endpoint": endpoint, "json": json})
        sku_id = json["id"]
        endpoints = {
            "2004543847939751938": "/rhart-image-n-pro/text-to-image",
            "2004543527918551041": "/rhart-image-n-pro/edit",
            "2012067220412493826": "/rhart-video-s-official/image-to-video-pro",
            "2012065966164602881": "/rhart-video-s-official/text-to-video-pro",
        }
        endpoint_path = self.endpoint_overrides.get(sku_id, endpoints[sku_id])
        return _FakePayloadResponse(
            {
                "code": 0,
                "msg": "success",
                "data": {
                    "id": sku_id,
                    "nameEn": f"fixture-{sku_id}",
                    "rhEndpoint": endpoint_path,
                },
            }
        )


def test_runninghub_media_doctor_validates_live_sku_metadata_without_leaking_keys(monkeypatch):
    key_values = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
    ]
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", ",".join(key_values))
    fake_client = _FakeSkuDetailClient()

    payload = runninghub_media_doctor(live_metadata=True, client=fake_client)

    assert payload["ok"] is True
    assert payload["ready_for_live_generation"] is True
    assert payload["configured_key_count"] == 3
    assert payload["summary"]["failed"] == 0
    assert len([check for check in payload["checks"] if check["name"].startswith("live_sku.")]) == 4
    assert {call["json"]["id"] for call in fake_client.calls} == {
        "2004543847939751938",
        "2004543527918551041",
        "2012067220412493826",
        "2012065966164602881",
    }
    assert all(call["endpoint"].endswith("/api/sku/detail") for call in fake_client.calls)
    payload_text = json.dumps(payload)
    for value in key_values:
        assert value not in payload_text


def test_runninghub_media_doctor_fails_closed_on_sku_endpoint_drift(monkeypatch):
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    fake_client = _FakeSkuDetailClient({"2004543847939751938": "/unexpected/text-to-image"})

    payload = runninghub_media_doctor(live_metadata=True, client=fake_client)

    assert payload["ok"] is False
    drift = next(check for check in payload["checks"] if check["name"] == "live_sku.text_to_image")
    assert drift["passed"] is False
    assert drift["data"]["remote_endpoint"] == "/unexpected/text-to-image"
    assert drift["data"]["expected_endpoint"] == "/rhart-image-n-pro/text-to-image"


def test_runninghub_outputs_query_extracts_output_urls_and_redacts_keys(tmp_path, monkeypatch):
    api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", api_key)
    fake_client = _FakeRunningHubClient()

    result = query_runninghub_media_task(
        "task_demo",
        query="outputs",
        mode="webapp",
        artifact_dir=tmp_path,
        client=fake_client,
    )

    assert result["output_urls"] == [
        "https://rh-images.example/output/demo.png",
        "https://rh-images.example/output/demo-video.mp4",
    ]
    assert fake_client.request_json == {"apiKey": api_key, "taskId": "task_demo"}
    artifact_payload = json.loads(Path(result["artifact_path"]).read_text(encoding="utf-8"))
    assert artifact_payload["output_urls"] == result["output_urls"]
    artifact_text = json.dumps(artifact_payload)
    assert api_key not in artifact_text
    assert artifact_payload["request"]["apiKey"] == "[REDACTED]"


def test_runninghub_standard_api_submit_uses_sku_endpoint_and_redacts_keys(tmp_path, monkeypatch):
    api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", api_key)
    fake_client = _FakeStandardSubmitClient()

    result = submit_runninghub_media_task(
        RunningHubMediaRequest(
            template="text_to_image",
            prompt="studio product photo",
            inputs={"aspectRatio": "1:1"},
            artifact_dir=tmp_path,
        ),
        client=fake_client,
    )

    assert fake_client.endpoint == "http://127.0.0.1:8790/openapi/v2/rhart-image-n-pro/text-to-image"
    assert fake_client.request_json == {
        "prompt": "studio product photo",
        "aspectRatio": "1:1",
        "resolution": "1k",
    }
    assert fake_client.request_headers == {"Authorization": f"Bearer {api_key}"}
    assert result["task_id"] == "task_standard_demo"
    artifact_text = Path(result["artifact_path"]).read_text(encoding="utf-8")
    assert "apiKey" not in artifact_text
    assert api_key not in artifact_text


def test_runninghub_standard_api_maps_source_image_fields(tmp_path, monkeypatch):
    api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", api_key)
    fake_client = _FakeStandardSubmitClient()

    submit_runninghub_media_task(
        RunningHubMediaRequest(
            template="image_to_video",
            prompt="slow camera push",
            source_image="https://example.com/input.png",
            artifact_dir=tmp_path,
        ),
        client=fake_client,
    )

    assert fake_client.request_json == {
        "resolution": "720p",
        "duration": "4",
        "prompt": "slow camera push",
        "imageUrl": "https://example.com/input.png",
    }


def test_runninghub_render_submits_polls_outputs_and_records_standard_artifact_chain(tmp_path, monkeypatch):
    api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", api_key)
    fake_client = _FakeStandardRenderRunningHubClient()

    result = render_runninghub_media_task(
        RunningHubMediaRenderRequest(
            generation=RunningHubMediaRequest(
                template="text_to_image",
                prompt="studio product photo",
                inputs={"aspectRatio": "1:1"},
                artifact_dir=tmp_path,
            ),
            max_polls=1,
            poll_interval_seconds=0,
        ),
        client=fake_client,
        sleep=lambda _seconds: None,
    )

    assert result["status"] == "outputs_ready"
    assert result["task_id"] == "task_render_demo"
    assert result["output_urls"] == ["https://rh-images.example/output/standard-render.png"]
    assert [step["step"] for step in result["steps"]] == ["generate", "status", "outputs"]
    assert result["artifact_count"] == 3
    assert [call["endpoint"].rsplit("/", 1)[-1] for call in fake_client.calls] == ["text-to-image", "query", "query"]
    for step in result["steps"]:
        artifact_payload = json.loads(Path(step["result"]["artifact_path"]).read_text(encoding="utf-8"))
        assert artifact_payload["artifact_id"] == step["result"]["artifact_id"]
        artifact_text = json.dumps(artifact_payload)
        assert api_key not in artifact_text


def test_runninghub_legacy_webapp_render_still_uses_task_openapi_chain(tmp_path, monkeypatch):
    api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_API_KEYS", api_key)
    monkeypatch.setenv(
        "SUPERCLAW_RUNNINGHUB_MEDIA_TEMPLATES_JSON",
        json.dumps({"text_to_image": {"mode": "ai-app"}}),
    )
    fake_client = _FakeLegacyRenderRunningHubClient()

    result = render_runninghub_media_task(
        RunningHubMediaRenderRequest(
            generation=RunningHubMediaRequest(
                template="text_to_image",
                prompt="studio product photo",
                node_info_list=(
                    {
                        "nodeId": "6",
                        "fieldName": "text",
                        "fieldType": "STRING",
                        "fieldValue": "studio product photo",
                    },
                ),
                artifact_dir=tmp_path,
            ),
            max_polls=1,
            poll_interval_seconds=0,
        ),
        client=fake_client,
        sleep=lambda _seconds: None,
    )

    assert result["status"] == "outputs_ready"
    assert result["output_urls"] == ["https://rh-images.example/output/render.png"]
    assert [call["endpoint"].rsplit("/", 1)[-1] for call in fake_client.calls] == ["run", "status", "outputs"]
