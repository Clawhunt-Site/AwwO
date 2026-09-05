"""Minimal OpenClaw Gateway WebSocket client.

OpenClaw exposes a stateful WebSocket RPC gateway (``openclaw gateway``). This
module speaks just enough of that protocol for SuperClaw to drive an agent turn
through it, verified end-to-end against a real local gateway (openclaw 2026.6.5).

Protocol (frames are JSON, one per WS message):
- ``{"type":"req","id","method","params"}`` — request
- ``{"type":"res","id","ok","payload"|"error"}`` — response
- ``{"type":"event","event","payload"}`` — server push

Handshake:
1. On open the server pushes ``connect.challenge`` with a ``nonce``.
2. The client sends ``connect`` with an Ed25519-signed device identity (v3
   payload) plus a shared ``auth.token``; the server replies ``hello-ok`` or
   ``NOT_PAIRED`` (a new device must be approved once by an operator —
   ``openclaw devices approve``; a configured key then stays paired).
3. ``agent`` (``message`` / ``sessionKey`` / ``idempotencyKey``) returns a
   ``runId`` with ``status:"accepted"`` (async), and ``agent.wait`` (``runId``)
   blocks for the terminal ``{status, output|error}``.

Only stdlib + ``websocket-client`` + ``cryptography`` (both already deps). Device
signing uses Ed25519, matching OpenClaw's ``v3`` device-auth payload.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

PROTOCOL_VERSION = 4
DEFAULT_CLIENT_ID = "gateway-client"
DEFAULT_CLIENT_MODE = "backend"
DEFAULT_ROLE = "operator"
DEFAULT_SCOPES = ("operator.admin",)


class OpenClawGatewayError(RuntimeError):
    """Raised for connect/handshake/protocol failures the caller should surface."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@dataclass
class DeviceIdentity:
    """An Ed25519 device identity used to sign the connect challenge.

    A *configured* key (``SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH``) yields a stable
    device id that, once approved by an operator, stays paired across runs — the
    sane production shape. Absent that, an ephemeral key is generated (each run
    is a new device that must be re-approved), which is fine for a one-shot smoke
    but not for unattended use.
    """

    device_id: str
    public_key_b64url: str
    _private_key: object  # Ed25519PrivateKey

    def sign(self, payload: str) -> str:
        return _b64url(self._private_key.sign(payload.encode("utf-8")))

    @classmethod
    def resolve(cls, key_path: str | None = None) -> "DeviceIdentity":
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _Ed

        path = key_path or os.environ.get("SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH", "").strip()
        if path and Path(path).exists():
            p = Path(path)
            # A long-lived device key must not be group/world readable; refuse a
            # loosely-permissioned key rather than silently trusting it. (POSIX
            # only — os.stat has no meaningful mode bits on Windows.)
            if os.name == "posix":
                mode = p.stat().st_mode & 0o777
                if mode & 0o077:
                    raise OpenClawGatewayError(
                        f"device key {path} is group/world accessible (mode {oct(mode)}); chmod 600 it"
                    )
            priv = serialization.load_pem_private_key(p.read_bytes(), password=None)
            if not isinstance(priv, _Ed):
                raise OpenClawGatewayError(f"device key {path} is not an Ed25519 key")
        else:
            priv = Ed25519PrivateKey.generate()
            if path:
                p = Path(path)
                p.parent.mkdir(parents=True, exist_ok=True)
                pem = priv.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
                # Create 0600 from the start (never world/group readable, even
                # for the brief window before a chmod) — this is a long-lived
                # device identity; leaking it leaks the paired device.
                fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    os.write(fd, pem)
                finally:
                    os.close(fd)
                os.chmod(str(p), 0o600)
        raw_pub = priv.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return cls(
            device_id=hashlib.sha256(raw_pub).hexdigest(),
            public_key_b64url=_b64url(raw_pub),
            _private_key=priv,
        )


def _build_device_auth_payload_v3(
    *, device_id: str, client_id: str, client_mode: str, role: str,
    scopes: list[str], signed_at_ms: int, token: str, nonce: str, platform: str,
) -> str:
    # "v3|deviceId|clientId|clientMode|role|scopes(comma)|signedAtMs|token|nonce|platform|deviceFamily"
    return "|".join([
        "v3", device_id, client_id, client_mode, role, ",".join(scopes),
        str(signed_at_ms), token, nonce, platform, "",
    ])


@dataclass
class AgentRunResult:
    """Terminal result of an agent run from ``agent.wait``."""

    status: str  # "completed" | "error" | "cancelled" | ...
    output: str
    error: str
    run_id: str
    raw: dict

    @property
    def ok(self) -> bool:
        return self.status == "completed"


class OpenClawGatewayClient:
    """Synchronous one-shot client: connect, run one agent turn, wait, close.

    Transport is injectable (``connect_fn``) so tests can drive the full protocol
    against an in-memory fake without a real socket.
    """

    def __init__(
        self,
        url: str,
        *,
        token: str = "",
        client_id: str = DEFAULT_CLIENT_ID,
        client_mode: str = DEFAULT_CLIENT_MODE,
        role: str = DEFAULT_ROLE,
        scopes: tuple[str, ...] = DEFAULT_SCOPES,
        device: DeviceIdentity | None = None,
        connect_fn=None,
    ) -> None:
        self.url = url
        self.token = token
        self.client_id = client_id
        self.client_mode = client_mode
        self.role = role
        self.scopes = list(scopes)
        self._device = device
        self._connect_fn = connect_fn
        self._ws = None

    def _device_identity(self) -> DeviceIdentity:
        if self._device is None:
            self._device = DeviceIdentity.resolve()
        return self._device

    def _open(self, timeout: float):
        if self._connect_fn is not None:
            return self._connect_fn(self.url, timeout)
        import websocket  # websocket-client

        return websocket.create_connection(
            self.url, timeout=timeout, max_size=25 * 1024 * 1024
        )

    def _recv(self) -> dict:
        raw = self._ws.recv()
        if not raw:
            raise OpenClawGatewayError("gateway closed the connection (empty frame)")
        try:
            frame = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise OpenClawGatewayError(f"gateway sent a non-JSON frame: {exc}") from exc
        if not isinstance(frame, dict):
            raise OpenClawGatewayError("gateway frame was not a JSON object")
        return frame

    def _send(self, frame: dict) -> None:
        self._ws.send(json.dumps(frame))

    def _request(self, method: str, params: dict, timeout: float) -> dict:
        # Sync the underlying socket read timeout to THIS request's budget — the
        # connect timeout would otherwise leak into a long agent.wait and kill it
        # early.
        try:
            self._ws.settimeout(timeout)
        except Exception:
            pass
        req_id = str(uuid.uuid4())
        self._send({"type": "req", "id": req_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self._recv()
            if frame.get("type") == "res" and frame.get("id") == req_id:
                if not frame.get("ok"):
                    err = frame.get("error") or {}
                    raise OpenClawGatewayError(
                        err.get("message") or f"{method} failed",
                        code=err.get("code"),
                    )
                return frame.get("payload") or {}
            # ignore unrelated events (health pushes, other-run events)
        raise OpenClawGatewayError(f"timeout waiting for {method} response")

    def connect(self, timeout: float) -> dict:
        self._ws = self._open(timeout)
        challenge = self._recv()
        if challenge.get("event") != "connect.challenge":
            raise OpenClawGatewayError(
                f"expected connect.challenge, got {challenge.get('event') or challenge.get('type')}"
            )
        nonce = (challenge.get("payload") or {}).get("nonce")
        if not nonce:
            raise OpenClawGatewayError("gateway challenge missing nonce")

        # The v3 payload is "|"-joined; a token containing "|" or "," would let a
        # field boundary be forged, so reject it rather than sign an ambiguous blob.
        if "|" in self.token or "," in self.token:
            raise OpenClawGatewayError("gateway token must not contain '|' or ',' (v3 payload delimiter)")
        dev = self._device_identity()
        signed_at = int(time.time() * 1000)
        payload = _build_device_auth_payload_v3(
            device_id=dev.device_id, client_id=self.client_id,
            client_mode=self.client_mode, role=self.role, scopes=self.scopes,
            signed_at_ms=signed_at, token=self.token, nonce=nonce, platform=sys.platform,
        )
        params: dict = {
            "minProtocol": 1,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {"id": self.client_id, "version": "0.1.0", "platform": sys.platform, "mode": self.client_mode},
            "role": self.role,
            "scopes": self.scopes,
            "device": {
                "id": dev.device_id,
                "publicKey": dev.public_key_b64url,
                "signature": dev.sign(payload),
                "signedAt": signed_at,
                "nonce": nonce,
            },
        }
        if self.token:
            params["auth"] = {"token": self.token}
        return self._request("connect", params, timeout)

    def run_agent(self, message: str, *, session_key: str, timeout: float) -> str:
        payload = self._request(
            "agent",
            {"message": message, "sessionKey": session_key, "idempotencyKey": str(uuid.uuid4())},
            timeout,
        )
        run_id = payload.get("runId")
        if not run_id:
            raise OpenClawGatewayError("agent request returned no runId")
        return run_id

    def wait_agent(self, run_id: str, timeout: float) -> AgentRunResult:
        payload = self._request("agent.wait", {"runId": run_id}, timeout)
        return AgentRunResult(
            status=str(payload.get("status") or "unknown"),
            output=str(payload.get("output") or payload.get("summary") or ""),
            error=str(payload.get("error") or ""),
            run_id=str(payload.get("runId") or run_id),
            raw=payload,
        )

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None
