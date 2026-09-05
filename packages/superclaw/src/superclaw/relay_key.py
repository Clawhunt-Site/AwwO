"""Relay key chain — clawwork 的 LLMgate 中转站 key 自动发放（客户端侧）。

服务端对应 PaySwitch-LLMgate 的 /api/v1/bridge（三方安全评审裁决落地）：
登录态 access_token 只作一次性后端验真输入，换回 scope=key_provision 的
短时 bridge token，再用它幂等发放 ``superclaw-clawwork:{device_id}`` 命名
空间下的专用 key（服务端强制 quota/RPM/过期上限）。

内核 key 解析链（顺序即优先级）::

    SUPERCLAW_RELAY_API_KEY 环境变量        # 手动覆盖，永远最高
      → clawhunt-auth.json 的 relay_api_key  # 此前自动发放的缓存（0600）
        → ensure（已登录）：exchange + /bridge/keys/ensure 自动发放
          → 都没有：fail-closed，给出可操作指引

安全硬约束（与服务端对齐）：
  - 主站 access_token 与 relay key 明文绝不进日志 / stdout；status 只展示
    key_prefix 掩码。
  - bridge token 只存活在单次 ensure 调用的内存里，不落盘。
  - 本地明文丢失（服务端已有同名 key）→ 走 rotate（先建新后吊销旧），
    绝不无限增发。
  - email 冲突（409）原样转成指引性错误，不重试。
"""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import urllib.parse
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:  # POSIX file locking
    import fcntl
except ImportError:  # pragma: no cover - platform dependent (Windows has no fcntl)
    fcntl = None  # type: ignore[assignment]

try:  # Windows file locking
    import msvcrt
except ImportError:  # pragma: no cover - platform dependent
    msvcrt = None  # type: ignore[assignment]

import httpx

from superclaw.clawhunt_auth import (
    load_clawhunt_auth,
    save_clawhunt_auth,
    saved_clawhunt_access_token,
)
from superclaw.plugin_proxy import PAYAGENT_INSTALLER_ENV_FILE

logger = logging.getLogger("superclaw.relay_key")

RELAY_KEY_ENV = "SUPERCLAW_RELAY_API_KEY"
# provenance 标记：当 RELAY_KEY_ENV 是本进程从缓存 hydrate 注入的（而非用户
# 显式设置）时，此伴随 env 置位。用于区分"手动 env 逃生口"与"hydrate 产物"，
# 以闭合跨进程 stale env：另一进程 rotate 后，本进程 hydrate 出的旧 env 不会被
# 误当成手动逃生口而绕过锁/缓存刷新（顾问评审 #4 第三轮）。
RELAY_KEY_HYDRATED_ENV = "SUPERCLAW_RELAY_API_KEY_HYDRATED"
# 可用性边界（非安全边界）：此标记仅供 SuperClaw 内部设置。若调用方/service
# manager 同时手动设置 RELAY_KEY 与本标记，会把手动 key 降级为"受治理可刷新"，
# 即 stored 变化时被覆盖。这不是权限绕过（能改 env 的主体本就能改 RELAY_KEY），
# 手动配置请勿设置本标记。
RELAY_BASE_URL_ENV = "SUPERCLAW_RELAY_BASE_URL"
RELAY_BRIDGE_URL_ENV = "SUPERCLAW_RELAY_BRIDGE_URL"
DEVICE_ID_PATH_ENV = "SUPERCLAW_DEVICE_ID_PATH"
RELAY_LOCK_PATH_ENV = "SUPERCLAW_RELAY_LOCK_PATH"
RELAY_AUDIT_PATH_ENV = "SUPERCLAW_RELAY_AUDIT_PATH"
DEFAULT_BRIDGE_BASE_URL = "https://api.clawhunt.site"
# bridge base 白名单：access_token 是主站最高权限凭据，只能发往可信中转。
# 环境变量（SUPERCLAW_RELAY_BRIDGE_URL / _BASE_URL）可被 .env / 启动脚本 / 恶意工程
# 环境污染——无白名单 = token 可被诱导 POST 到任意地址（SSRF/钓鱼外泄，顾问评审 P1）。
# 仅 https + 白名单 host + 端口 None/443 才放行。绝不提供 env 级 unsafe 逃生口
# （原始威胁就是 env 污染——攻击者能同时设恶意 BRIDGE_URL + unsafe 开关使白名单失效）；
# 自定义中转只走代码级 RelayBridgeClient(allow_insecure=True)，永不从环境读。
_BRIDGE_HOST_ALLOWLIST = frozenset({"api.clawhunt.site"})
DEFAULT_DEVICE_ID_PATH = Path.home() / ".superclaw" / "device-id"
DEFAULT_RELAY_LOCK_PATH = Path.home() / ".superclaw" / "relay-key.lock"
# 账务/安全审计日志：append-only JSONL，永久留痕每次 key 发放/轮换/吊销/自愈。
# 涉及真金白银——每把 key 何时、由哪个 device、以何 source 发放/吊销必须可追溯
# （配合服务端 usage_logs 按 device-named key 归因的消费记录，形成完整账务链）。
DEFAULT_RELAY_AUDIT_PATH = Path.home() / ".superclaw" / "relay-audit.jsonl"

# 与服务端 bridge._DEVICE_ID_RE 对齐：不合法字符替换、64 上限
_DEVICE_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")
# 任何"看起来像 key 的字符串"展示前的安全显示长度（本地强制，不信任来源）
_DISPLAY_PREFIX_LEN = 14
# 合法 LLMgate key 前缀格式（展示层白名单：只有匹配的才允许回显其 mask 版）
_KEY_PREFIX_RE = re.compile(r"^sk-llmgate-[A-Za-z0-9._-]+$")


def _mask_key(value: Any) -> str:
    """把任何明文 key 安全压成展示用前缀。

    不信任来源（顾问评审 #3）：非字符串、不符合 key 格式的污染值,一律返回固定
    占位 'set'/'unset'，绝不回显原值；合法 key 截断到显示长度。
    """
    if not isinstance(value, str) or not value:
        return "unset" if not value else "set"
    if not _KEY_PREFIX_RE.match(value):
        # 不是合法 key 格式（可能是被污染的脏值）→ 不回显，只表态"有值"
        return "set"
    return value[:_DISPLAY_PREFIX_LEN] + "..." if len(value) > _DISPLAY_PREFIX_LEN + 3 else "set"


def _safe_text(value: Any) -> Any:
    """非密钥文本字段（如 key_name）的兜底：非字符串→占位；过长→截断。"""
    if value is None:
        return None
    if not isinstance(value, str):
        return "set"
    return value[:_DISPLAY_PREFIX_LEN] + "..." if len(value) > _DISPLAY_PREFIX_LEN + 3 else value


class RelayKeyError(RuntimeError):
    """relay key 链上的可操作失败（携带给用户的指引文案）。

    code 是结构化错误码（如 RELAY_RESPONSE_LOST / RELAY_UNREACHABLE），供自愈等
    逻辑精确判定——绝不靠 str(exc) substring 匹配（错误文案含 base_url，substring
    会被恶意/异常 URL 污染而误判，进而误清有效 key，顾问评审）。
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def _ensure_secure_parent(path: Path) -> None:
    """创建 path 的父目录（~/.superclaw）并尽力收紧到 0700——与 clawwork agent_dir 的
    0700 posture 一致。目录内的凭据文件本身都已 0600，这里再把目录也收紧到仅属主可
    遍历，杜绝同机其它本地用户列目录 / 探测文件名（纵深防御，顾问评审 F-M2）。
    chmod 失败不阻断（best-effort，与文件 chmod 一致）。"""
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        parent.chmod(0o700)
    except OSError:
        pass
    if os.name == "nt":
        # chmod(0o700) is a no-op on NTFS; restrict ~/.superclaw to the current
        # user via an explicit ACL so the 0600 credential/key files inside sit in
        # an owner-only directory (defense in depth, advisor F-M2).
        from superclaw.secure_fs import harden_path

        harden_path(parent, is_dir=True)


# ------------------------------------------------------------------
# 账务/安全审计日志
# ------------------------------------------------------------------

def relay_audit_path() -> Path:
    return Path(os.environ.get(RELAY_AUDIT_PATH_ENV, DEFAULT_RELAY_AUDIT_PATH))


# 受控文本字段落盘的硬性长度上限（防上游构造超长串撑爆审计磁盘，DoS）。
_AUDIT_FIELD_MAXLEN = 256
# 审计行里允许出现的字段白名单——硬性防止误把明文 key / access_token 写进日志。
_AUDIT_ALLOWED_FIELDS = frozenset(
    {
        "device_id",
        "source",
        "key_prefix",
        "key_name",
        "key_id",
        "quota_limit",
        "rate_limit",
        "expires_at",
        "rotated",
        "account_created",
        "error_code",
        "reason",
        "revoked_count",
        # 账号归属维度：发放/轮换/自愈事件记当前登录账号的稳定标识（sub:<主站id>
        # 或 tok:<指纹>，均非密钥），让账务可按账号归因、事后能证明 key 属于谁，
        # 杜绝"切号串 key"无法追溯（顾问评审：审计缺账号 owner 维度）。
        "account_owner",
    }
)
# 注意：URL（如 bridge_base_url）刻意不入白名单——它可能在未来携带 userinfo/query
# token，原样落盘有泄露风险。审计只记不可逆标识，不记可能含凭据的 URL。


def _audit(event: str, **fields: Any) -> None:
    """向 append-only 审计日志写一条账务/安全事件，并发一条标准 logging。

    安全硬约束：只允许 _AUDIT_ALLOWED_FIELDS 里的字段落盘，且对 key 类字段强制
    本地脱敏——审计日志绝不含明文 relay key 或 ClawHunt access_token。审计失败
    绝不阻断主流程（best-effort）。
    """
    record: dict[str, Any] = {"ts": datetime.now(UTC).isoformat(), "event": event}
    for name, value in fields.items():
        if value is None or name not in _AUDIT_ALLOWED_FIELDS:
            continue
        if name == "key_prefix":
            # 唯一可能含 key 的字段：经 key-format 白名单强制脱敏
            record[name] = _mask_key(value)
        elif name == "key_name":
            # 服务端给的名字，截断防御污染（非账务关键，可截）
            record[name] = _safe_text(value)
        elif isinstance(value, str):
            # 受控标识/文本字段（device_id/source/error_code/reason/...）：记完整值
            # 但硬性封顶 _AUDIT_FIELD_MAXLEN，防上游构造超长串撑爆审计磁盘（DoS）。
            record[name] = value[:_AUDIT_FIELD_MAXLEN]
        elif isinstance(value, bool) or isinstance(value, (int, float)):
            # 标量数值/布尔（key_id/rate_limit/account_created/...）：原值
            record[name] = value
        else:
            # 白名单字段名虽允许，但值若是嵌套 dict/list 等非标量（恶意/异常服务端
            # 可塞 quota_limit={"access_token":"x"} 之类），绝不原样落盘——只表态"有值"，
            # 杜绝嵌套敏感数据穿透审计日志与 logging extra（顾问评审：审计零信任）。
            record[name] = "<non-scalar>"
    logger.info("relay_%s", event, extra={"relay_audit": record})
    try:
        # 序列化也纳入 best-effort：record 里若混入不可序列化对象（不应发生，但防御），
        # json.dumps 的 TypeError/ValueError 同样不得阻断 key 发放/使用。
        line = json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
        path = relay_audit_path()
        _ensure_secure_parent(path)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except (OSError, TypeError, ValueError):
        # 审计落盘/序列化失败都不阻断主流程（logging 已记录该事件）
        logger.warning("relay_audit_write_failed event=%s", event)


# ------------------------------------------------------------------
# 设备身份与端点解析
# ------------------------------------------------------------------

def _sanitize_device_id(raw: str) -> str:
    cleaned = _DEVICE_ID_SAFE_RE.sub("-", raw.strip())[:64]
    return cleaned or "unknown-device"


def _normalize_tier(tier: Any) -> str | None:
    """规范化 SuperClaw 套餐档位 tier：小写、仅 core/plus/max 之一，否则 None。

    单一规范化口径（与服务端 bridge + 主站 ``superclaw_tier.superclaw_bridge_tier``
    对齐）：非法 / 缺失 tier 一律 None，让上层 fail-safe 落 core，绝不把脏值送进 device
    后缀或 exchange payload。延迟 import 打破 relay_packages→relay_key 的循环依赖。
    """
    if not isinstance(tier, str):
        return None
    norm = tier.strip().lower()
    from superclaw.relay_packages import SUPERCLAW_BRIDGE_TIER_SET

    return norm if norm in SUPERCLAW_BRIDGE_TIER_SET else None


# v18 卡包/服务档（subscription）：basic/standard/advanced，未订阅为 None。来自主站
# ``GET /api/auth/me`` 的 ``superclaw_plan`` 字段（``utils/superclaw_subscription.active_plan``）。
# 仅作展示/解锁集合推导用，绝不进 exchange payload（exchange 只认 tier=core/plus/max）。
SUPERCLAW_PLAN_SET = frozenset({"basic", "standard", "advanced"})


def _normalize_plan(plan: Any) -> str | None:
    """规范化 v18 卡包档位 ``superclaw_plan``：小写、仅 basic/standard/advanced 之一，否则 None。

    与主站 ``superclaw_subscription.active_plan`` 同口径：未订阅 / 过期 / 非法 一律 None。
    """
    if not isinstance(plan, str):
        return None
    norm = plan.strip().lower()
    return norm if norm in SUPERCLAW_PLAN_SET else None


def _group_slug_for_tier(tier: Any) -> str | None:
    """规范 tier → 隐藏分组 slug（``plus`` → ``superclaw-plus``）；非法/缺失 → None。"""
    norm = _normalize_tier(tier)
    if not norm:
        return None
    from superclaw.relay_packages import SUPERCLAW_RELAY_GROUP_SLUGS

    return SUPERCLAW_RELAY_GROUP_SLUGS.get(norm)


def _apply_tier_to_device_id(device_id: str, tier: Any) -> str:
    """给基础 device id 追加规范化 tier 后缀，使每个档位在中转站命名空间
    ``superclaw-clawwork:{device_id}`` 下落到**独立** key —— 切档即换 key、各档互不
    覆盖（对齐主站 ``llmgate_bridge._bridge_device_id``）。tier 缺失/非法时返回原
    device id（未选档 / 旧调用仍用单一 device，绑 fail-safe core）。总长 ≤64 与服务端
    ``bridge._DEVICE_ID_RE`` 上限一致。
    """
    norm = _normalize_tier(tier)
    if not norm:
        return device_id
    suffix = _DEVICE_ID_SAFE_RE.sub("-", norm).strip("-")[:24]
    if not suffix:
        return device_id
    # 给 tier 后缀预留空间：先把 base 截到 ``64-len(suffix)-1``（-1 留给 '-' 分隔符）再拼，
    # 保证 tier 标记**永不被截掉**。否则长 base device id（payagent id 可能接近 64）拼上后缀
    # 后整体截 64 会丢掉 tier 后缀，使 plus/max/core 撞到同一个服务端 key name
    # ``superclaw-clawwork:{device_id}`` —— 重新引入 #452 的跨档撞名（Codex 对抗项 #6）。
    keep = 64 - len(suffix) - 1
    base = device_id[:keep] if keep > 0 else device_id[:64]
    return f"{base}-{suffix}"


def _payagent_device_id() -> str | None:
    """PayAgent 安装器授权过的设备 id 优先复用（与 pay-switch 同一身份）。"""
    try:
        text = PAYAGENT_INSTALLER_ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "PAY_SWITCH_DEVICE_ID" and value.strip():
            return value.strip()
    return None


def device_id_path() -> Path:
    return Path(os.environ.get(DEVICE_ID_PATH_ENV, DEFAULT_DEVICE_ID_PATH))


def superclaw_device_id(*, create: bool = True) -> str | None:
    """本机稳定设备 id：payagent 授权 id 优先，否则读已持久化的；

    create=False 时只读不写（供 status 等只读命令用，无写盘副作用——顾问
    评审 #4）；既无 payagent 也无文件则返回 None。create=True 时首次生成
    并以 0600 持久化。
    """
    payagent = _payagent_device_id()
    if payagent:
        return _sanitize_device_id(payagent)
    path = device_id_path()
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if existing:
        return _sanitize_device_id(existing)
    if not create:
        return None
    generated = f"sc-{uuid.uuid4().hex[:24]}"
    _ensure_secure_parent(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(generated + "\n")
    return generated


def relay_lock_path() -> Path:
    return Path(os.environ.get(RELAY_LOCK_PATH_ENV, DEFAULT_RELAY_LOCK_PATH))


@contextlib.contextmanager
def _relay_provision_lock() -> Iterator[None]:
    """跨进程排他锁，包住整段 读缓存→exchange→ensure/rotate→落盘。

    消除顾问评审 #2 的 TOCTOU：两个进程同时无本地 key 时，一个会建 key，
    另一个看到 created=false 后 rotate 会吊销前者——无锁则后落盘者可能存下
    已被吊销的 key。锁让发放串行化，拿锁后必须重读缓存。
    """
    path = relay_lock_path()
    _ensure_secure_parent(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        elif msvcrt is not None:  # pragma: no cover - platform dependent (Windows)
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:  # pragma: no cover - platform dependent
            raise RuntimeError("no file-locking primitive available; refusing unlocked relay provision")
        yield
    finally:
        with contextlib.suppress(OSError):
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - platform dependent (Windows)
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


def relay_bridge_base_url() -> str:
    """bridge API 的 base URL：显式 env → 从 relay base 推导（剥掉 /v1，仅当推导出的 host
    本身是白名单 bridge origin）→ 默认。

    relay API 与 access_token bridge 可在不同 host（如 relay=gate.clawhunt.site /
    bridge=api.clawhunt.site）。若直接拿 relay host 当 bridge base，会推导出一个非白名单
    host，导致可用性显示 READY 但 exchange 阶段被 `_is_allowed_bridge_url` 闸门拒（顾问
    对抗评审 #4：false READY → run 失败）。因此推导结果必须先过白名单，否则回退到规范
    bridge base（api.clawhunt.site）——self-deployed relay 的账号 token 仍走 ClawHunt 官方
    bridge。
    """
    explicit = (os.environ.get(RELAY_BRIDGE_URL_ENV) or "").strip()
    if explicit:
        return explicit.rstrip("/")
    # Derive from the *resolved* relay base (explicit env override > per-environment
    # baked default), not raw os.environ, so the baked default participates instead of
    # silently falling through to DEFAULT_BRIDGE_BASE_URL.
    from superclaw.environment import relay_base_url as _resolved_relay_base

    relay_base = _resolved_relay_base().rstrip("/")
    if relay_base:
        candidate = relay_base[: -len("/v1")] if relay_base.endswith("/v1") else relay_base
        if _is_allowed_bridge_url(candidate):
            return candidate
    return DEFAULT_BRIDGE_BASE_URL


def _is_allowed_bridge_url(url: str) -> bool:
    """bridge base 是否可信：仅 https + 白名单 host + 端口 None/443。

    access_token 只在 exchange 发往 bridge——这道闸门防它被污染的环境变量送往恶意主机
    （顾问对抗评审 P1：客户端无白名单管控会把最高权限登录态"送货上门"给攻击者）。
    硬约束（顾问第二轮）：
      - 绝不在此提供 env 级 unsafe 逃生口——原始威胁就是 env 污染，攻击者能同时设
        恶意 BRIDGE_URL + unsafe 开关使白名单失效；自定义中转只走代码级构造参数。
      - host 精确匹配（非后缀/子串），杜绝 api.clawhunt.site.evil.test 之类仿冒。
      - 约束 origin 而非仅 host：端口必须 None 或 443，挡住 api.clawhunt.site:8443
        这类把 token 发往同主机其它（可能不可信）端口的构造。
      - 拒绝 userinfo（user:pass@host）：可信 bridge 不该被附带 Basic auth 凭据（顾问纵深）。
      - 先挡控制字符/空字节：防 CVE-2023-24329 类前导空白/控制符扰乱 urlparse 解析（顾问纵深）。
    """
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f or ch.isspace() for ch in url):
        return False
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port  # 畸形端口（如 :99999）会抛 ValueError
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in _BRIDGE_HOST_ALLOWLIST
        and port in (None, 443)
        # 用 is None：not username 会放行空 userinfo（如 https://@host，username==""）（顾问第四轮）
        and parsed.username is None
        and parsed.password is None
    )


def _is_loopback_host(host: str) -> bool:
    """host 是否 loopback：localhost 或 127.0.0.0/8 / ::1（用 ipaddress 判，含 127.0.0.2
    等合法 loopback 变体；unspecified 0.0.0.0 / mapped 等非 loopback 一律 False，顾问第二轮）。"""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_relay_base_url(raw: str | None) -> str:
    """校验并规范化 relay base URL（relay key 会作 Bearer 发往它）——所有发凭据到 relay
    base 的客户端消费点（余额查询 / 模型发现）统一走这道闸门。

    relay base 可自部署（不硬白名单 host，区别于 bridge 的 access_token 闸门），但必须：
      - 先挡控制符/空白/反斜杠（防 urlparse 解析歧义 / 字面绕过）；
      - 仅 https（http 只允许 loopback 本地开发——remote http 会让 relay key 明文出网）；
      - host 非空、无 userinfo（防 api.clawhunt.site@evil 把 key exfil 到攻击者 host）、
        无 query/fragment、端口合法、path 只能为空或 /v1（防契约路径漂移）。
    任何不合 → RelayKeyError，且**绝不回显原始 base**（可能含 secret，如 ?token=...），
    只给固定码 + env 名（顾问第三/四轮）。返回规范化后的安全 base。
    """
    raw = raw or ""
    # 拒绝 %：urlparse 不解码 %40(@)/%2f(/)/%5c(\) 等，但 urllib.request / clawwork 等其它
    # 客户端会解码，导致 host 被改写（api.clawhunt.site%40evil → host=@evil）破坏"统一校验
    # 覆盖所有客户端解析差异"的不变量（顾问第二轮阻断项）。relay base（host + /v1）无合法 %
    # 用途，整段拒绝最稳。
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f or ch.isspace() for ch in raw) or "\\" in raw or "%" in raw:
        raise RelayKeyError(
            f"RELAY_BASE_URL_INVALID: {RELAY_BASE_URL_ENV} 含非法字符（控制符/空白/反斜杠/百分号）"
        )
    base = raw.strip().rstrip("/")
    if not base:
        raise RelayKeyError(
            f"RELAY_BASE_URL_MISSING: 未配置 {RELAY_BASE_URL_ENV}（LLMgate /v1 地址）"
        )
    try:
        parsed = urllib.parse.urlparse(base)
        port = parsed.port  # 畸形端口（:99999 等）抛 ValueError
    except ValueError:
        raise RelayKeyError(f"RELAY_BASE_URL_INVALID: {RELAY_BASE_URL_ENV} 无法解析为 URL")
    host = parsed.hostname
    if (
        parsed.scheme not in ("https", "http")
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/v1")
        or (port is not None and not 0 < port < 65536)
    ):
        raise RelayKeyError(
            f"RELAY_BASE_URL_INVALID: {RELAY_BASE_URL_ENV} 必须是无 userinfo/query/fragment、"
            "path 为空或 /v1 的 http(s) URL"
        )
    if parsed.scheme == "http" and not _is_loopback_host(host):
        raise RelayKeyError(
            f"RELAY_BASE_URL_INSECURE: {RELAY_BASE_URL_ENV} 非 loopback 必须用 https"
            "（防 relay key 明文出网）"
        )
    # 规范化：确保 base 以 /v1 结尾（所有 LLMgate 端点在 /v1 下；裸 host 补 /v1），统一各
    # 消费点 endpoint，避免 available 显示可用但 run/discovery/balance 走错 path（顾问非阻断）。
    if parsed.path == "":
        base = base + "/v1"
    return base


def resolve_relay_base_url() -> str:
    """解析当前环境的 relay base URL 并过安全闸门。

    取值优先级：显式 ``SUPERCLAW_RELAY_BASE_URL`` env/config 覆盖 > 按环境烤入的默认
    （``environment.RELAY_BASE_URLS``，随构建身份选 dev/staging/prod）。返回前一律经
    ``validate_relay_base_url``，所以无论来源是 env 覆盖还是内置默认，发 relay key 出网的
    https / no-userinfo / no-query / path∈{"",/v1} 安全不变量都成立。
    """
    from superclaw.environment import relay_base_url

    return validate_relay_base_url(relay_base_url())


def _mask_base_url(url: str | None) -> str:
    """relay/bridge base URL 的展示脱敏：只回显 scheme://host[:port]，绝不带
    path/query/fragment/userinfo（可能含 secret，如 ?token=...，顾问第四轮）。
    空 → unset；不可解析 / 无 host → invalid。
    """
    if not url or not isinstance(url, str):
        return "unset"
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port
    except ValueError:
        return "invalid"
    if not parsed.scheme or not parsed.hostname:
        return "invalid"
    # IPv6 host 补回中括号（urlparse.hostname 去掉了），否则 ::1:8001 有歧义（顾问非阻断）。
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    netloc = host if port is None else f"{host}:{port}"
    return f"{parsed.scheme}://{netloc}"


# ------------------------------------------------------------------
# Bridge HTTP 客户端
# ------------------------------------------------------------------

class RelayBridgeClient:
    """LLMgate /api/v1/bridge 的最小客户端。

    transport 注入口供测试（httpx.MockTransport）；trust_env=False 与
    clawhunt_auth.ClawHuntAccountClient 保持一致（不吃系统代理）。
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 20.0,
        allow_insecure: bool = False,
    ) -> None:
        self.base_url = (base_url or relay_bridge_base_url()).rstrip("/")
        # 代码级开发逃生口：仅供测试 / 显式自建中转用，绝不从环境读取（env 会被污染，
        # 那正是白名单要防的威胁）。生产 RelayBridgeClient() 不传 → 强制白名单。
        # 注意：绝不用 "transport is not None" 当安全判断——真实 httpx.HTTPTransport()
        # 也是注入 transport，那会让任意 base 绕过白名单（顾问第二轮阻断项）。
        self._allow_insecure = allow_insecure
        self._client = httpx.Client(
            base_url=self.base_url,
            transport=transport,
            timeout=timeout,
            trust_env=False,
            # 显式禁止自动跟随重定向：一个恶意/被劫持的 3xx 不能把携带 bridge token
            # 的请求重定向到攻击者主机而泄露 Authorization 头（与服务端 verify 一致）。
            follow_redirects=False,
        )

    def _post(self, path: str, *, json: dict[str, Any] | None = None, token: str | None = None) -> httpx.Response:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            return self._client.post(path, json=json, headers=headers)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # InvalidURL（malformed bridge URL）不是 HTTPError 子类，一并捕获，避免裸
            # traceback；它请求根本没发出，落入下面的默认 RELAY_UNREACHABLE 分支，不清 key。
            logger.debug("relay_post_error type=%s path=%s", type(exc).__name__, path)
            # 决定 rotate 自愈是否该清本地 key，采用 fail-safe 白名单（顾问 #2 第二/三轮）：
            # 只有*能证明请求已完整发出、服务端可能已处理*的异常才算 RELAY_RESPONSE_LOST：
            #   - ReadTimeout/ReadError：请求已发完，在等/读响应阶段失败（很可能已到服务端）
            #   - RemoteProtocolError：服务端已响应但协议坏（已到服务端、可能已处理）
            # 其余一切都默认 RELAY_UNREACHABLE、绝不清 key——尤其 WriteTimeout/WriteError
            # 是*写出阶段*失败（请求还没发完），不能证明被服务端收到；连接失败/超时、
            # 协议错误、URL 非法、重定向超限同理。不确定时保守不清，宁可多一次重试也绝不
            # 误删有效 key。
            maybe_submitted = isinstance(
                exc,
                (
                    httpx.ReadTimeout,
                    httpx.ReadError,
                    httpx.RemoteProtocolError,
                ),
            )
            code = "RELAY_RESPONSE_LOST" if maybe_submitted else "RELAY_UNREACHABLE"
            raise RelayKeyError(
                f"{code}: 无法完成中转站桥接请求 {_mask_base_url(self.base_url)}"
                f"（{type(exc).__name__}）；请检查网络或 SUPERCLAW_RELAY_BRIDGE_URL",
                code=code,
            ) from exc

    def exchange(self, access_token: str, device_id: str, tier: str | None = None) -> dict[str, Any]:
        # 发送 access_token 前的可信闸门：始终强制（不依赖 transport 是否注入——真实
        # HTTPTransport 注入也必须挡住）。access_token 是主站最高权限凭据，绝不发往
        # 白名单外的中转，防被污染的 env 把它 exfil 到攻击者主机（顾问对抗评审 P1）。
        if not self._allow_insecure and not _is_allowed_bridge_url(self.base_url):
            raise RelayKeyError(
                "RELAY_BRIDGE_UNTRUSTED: 中转站地址不在可信白名单内，已拒绝发送 ClawHunt "
                f"登录态以防外泄（{_mask_base_url(self.base_url)}）；自定义中转请用代码级 "
                "RelayBridgeClient(allow_insecure=True)，绝不经环境变量开启",
                code="RELAY_BRIDGE_UNTRUSTED",
            )
        # 携带本 access_token 的签发环境（staging / production）：中转站据此回源对应
        # ClawHunt 验真。staging token 只对 staging 主站有效，缺该信号会被生产主站拒
        # （跨环境验真失败）。app_environment() 返回 canonical 值，与构建身份一致。
        from superclaw.environment import app_environment

        payload: dict[str, Any] = {
            "access_token": access_token,
            "device_id": device_id,
            "environment": app_environment(),
        }
        # 用户在 SuperClaw 选的套餐档位：中转站据此把发放的 key 绑定到隐藏分组
        # superclaw-{tier}（计费倍率 + 分组路由闸）。只传规范化后的合法 tier；缺失/非法
        # 一律不带 tier 字段，中转站 fail-safe 落 superclaw-core（对齐主站
        # llmgate_bridge._exchange + 服务端 bridge._resolve_group_id_for_tier）。
        norm_tier = _normalize_tier(tier)
        if norm_tier:
            payload["tier"] = norm_tier
        response = self._post("/api/v1/bridge/exchange", json=payload)
        if response.status_code == 409:
            raise RelayKeyError(
                "RELAY_EMAIL_CONFLICT: 该 ClawHunt 邮箱在 LLMgate 已有本地账户；"
                "请登录 gate.clawhunt.site 网页端完成手动绑定后重试"
            )
        if response.status_code == 404:
            raise RelayKeyError(
                "RELAY_BRIDGE_DISABLED: 中转站尚未开启账户桥接"
                f"（{_mask_base_url(self.base_url)} 返回 404）；请确认 LLMgate 已部署并开启 CLAWHUNT_BRIDGE_ENABLED"
            )
        if response.status_code == 429:
            raise RelayKeyError("RELAY_RATE_LIMITED: 桥接请求过于频繁，请稍后重试")
        if response.status_code == 503:
            # 中转站未为本环境（如 staging）配置桥接目标：系统级配置缺失，不是登录态失效，
            # 单独成码避免误导用户去反复重新登录（顾问双指出的可诊断性缺口）。
            raise RelayKeyError(
                "RELAY_BRIDGE_STAGING_UNAVAILABLE: 中转站未启用本环境的账户桥接"
                f"（{_mask_base_url(self.base_url)} 返回 503）；请确认 LLMgate 已配置对应环境的 "
                "ClawHunt 目标，或联系管理员",
                code="RELAY_BRIDGE_STAGING_UNAVAILABLE",
            )
        if response.status_code == 422:
            # 中转站拒绝了本次 environment 取值：客户端与中转站版本不一致（而非登录态问题）。
            raise RelayKeyError(
                "RELAY_BRIDGE_BAD_ENVIRONMENT: 中转站拒绝了本次请求的 environment 取值；"
                "通常是 SuperClaw 与中转站版本不一致，请升级后重试",
                code="RELAY_BRIDGE_BAD_ENVIRONMENT",
            )
        if response.status_code != 200:
            # fail-closed：不区分细节（服务端本就统一 401 防枚举）
            raise RelayKeyError(
                "RELAY_EXCHANGE_REJECTED: ClawHunt 登录态未通过中转站验真；"
                "请先 `superclaw clawhunt account-login`（或刷新登录）后重试"
            )
        return response.json()

    def ensure_key(self, bridge_token: str) -> dict[str, Any]:
        response = self._post("/api/v1/bridge/keys/ensure", token=bridge_token)
        if response.status_code != 200:
            raise RelayKeyError(f"RELAY_ENSURE_FAILED: 中转站 key 发放失败（HTTP {response.status_code}）")
        return response.json()

    def rotate_key(self, bridge_token: str) -> dict[str, Any]:
        response = self._post("/api/v1/bridge/keys/rotate", token=bridge_token)
        if response.status_code != 200:
            raise RelayKeyError(f"RELAY_ROTATE_FAILED: 中转站 key 轮换失败（HTTP {response.status_code}）")
        return response.json()

    def close(self) -> None:
        self._client.close()


# ------------------------------------------------------------------
# 解析链与 ensure 编排
# ------------------------------------------------------------------

def _stored_key() -> str:
    raw = load_clawhunt_auth().get("relay_api_key")
    return raw.strip() if isinstance(raw, str) else ""


def _current_account_identity(auth: dict[str, Any] | None = None) -> str | None:
    """当前 ClawHunt 登录账号的稳定标识——把 relay key 钉死在发放它的账号上。

    防"切号串 key"：同机从账号 A 切到 B 后，绝不能让 B 复用 A 发放的 relay key
    （那会扣 A 的真金白银、把 B 的用量记到 A 头上——账务盗刷 + 隐私串号）。

    可传入 auth snapshot（单次 load 的结果）以保证与同一时刻读出的 access_token
    同源——发放路径据此消除"exchange 与落盘之间另一进程切号"的竞态（顾问第二轮）。

    取值优先级（顾问对抗评审裁决）：
      1. 主站稳定 user id（account_user.id）——同账号 access_token 轮换/刷新时它
         不变，故 token 过期重登也不会误判失配触发无谓重发（绝不用 access_token
         指纹做主标识：token 轮换会把同账号有效 key 误杀，引发惊群 rotate）；
      2. 仅当登录响应未带 user.id 时，退化为 access_token 指纹（同 token 生命周期内
         稳定，能区分不同账号的不同 token，代价是同账号 token 轮换会多发一次 key）；
      3. 无登录态 → None（此时不存在"另一个账号在场"，归属校验对其放行，见
         _owned_stored_key）。
    """
    auth = auth if auth is not None else load_clawhunt_auth()
    user = auth.get("account_user")
    if isinstance(user, dict) and user.get("id") is not None:
        return f"sub:{user['id']}"
    token = auth.get("access_token")
    if isinstance(token, str) and token.strip():
        return "tok:" + hashlib.sha256(token.strip().encode()).hexdigest()[:32]
    return None


def _owned_stored_key(auth: dict[str, Any], *, tier: str | None = None) -> str:
    """从单个 auth snapshot 判定归属当前账号（且匹配档位）的 stored key 明文（隔离闸门）。

    档位维度（issue #452）：当调用方指定 ``tier`` 时，stored 还必须绑定**同一档位**才命中
    —— 切档（``relay_key_tier`` 不匹配）视同未命中，触发按当前档位重新发放，绝不复用绑了旧
    分组的 key（验收：切档换池）。``tier=None``（不关心档位的通用消费方，如
    resolve/status/hydrate）保持原行为，只看账号归属。规范化口径：缺失/非法档位标签一律视同
    ``core``（旧 key 无标签时本就绑 fail-safe core）。


    返回归属当前账号的 stored key；失配 / 无主（有登录态时）/ 无 stored → ""。
    所有字段（relay_api_key / relay_key_owner / account_user / access_token）都从
    *同一个* auth dict 取——杜绝"读 stored 与判 owner 之间被另一进程切号"的跨快照
    竞态（顾问第二轮：旧实现 resolve 读 stored 后又多次重读 auth 判 owner，中途切号
    会用旧 A key + 新账号数据误判通过，把 A 的 key 返回给 B）。

    语义：
      - 当前有登录态：stored 必须带 owner 且 == 当前账号标识，否则失配——
          * owner != current：切号了，别账号的 key，绝不可用；
          * owner 缺失（历史遗留 / 无主 key）：无法证明归属，按 unknown 不信任、
            强制按当前账号重发（安全优先；现网桥接 flag 未开、零存量，零成本）。
      - 当前无登录态（current is None）：只放行*无主*的本机历史 key（无 owner 标记 →
        无串号方）；带 owner 的 key 绝不在无身份下放行（顾问第三轮：登出后归属真空——
        否则无登录进程能取用某账号的 key）。token 过期时文件里 access_token 仍在
        （current 仍非 None），"过期仍可用自己的 key"由有身份分支保证，不靠这里。
    """
    raw = auth.get("relay_api_key")
    stored = raw.strip() if isinstance(raw, str) and raw.strip() else ""
    if not stored:
        return ""
    owner_raw = auth.get("relay_key_owner")
    owner = owner_raw if isinstance(owner_raw, str) and owner_raw else None
    current = _current_account_identity(auth)
    if current is None:
        # 无身份（登出 / 无 token）：只放行*无主*的本机历史 key（无归属标记 → 无串号方）；
        # 带 owner 的 key 绝不在无身份状态放行——否则无登录进程能取用某账号的 key
        # （顾问第三轮：登出后归属真空）。
        owned = owner is None
    else:
        owned = bool(owner and owner == current)
    if not owned:
        return ""
    # 档位闸（issue #452）：调用方指定 tier 时，stored 还须绑定同一档位才命中。want/have 都
    # 规范化，缺失/非法→core（旧 key 无标签本就绑 fail-safe core）；切档即未命中触发重发。
    #
    # 无归属 legacy key 的行为声明（Codex 对抗项 #4）：登出态（current is None）下，owner 闸只
    # 放行*无主* key（上面 owned=owner is None）。档位闸对它的判定：legacy key 无 relay_key_tier
    # 标签 → have=core；调用方传 ``tier="core"`` 时 want=core 命中、传 ``tier="plus"/"max"`` 时
    # want≠core 未命中触发重发。即 explicit ``tier="core"`` 对无主 legacy key 的复用与 ``tier=None``
    # **完全一致**（沿用 base 早已接受的"无归属标记→无串号方"语义，**并未放宽**）；显式付费档绝不
    # 复用无主 key，必重发绑对分组。故无新增的跨账号 key 复用面。
    if tier is not None:
        want = _normalize_tier(tier) or "core"
        have = _normalize_tier(auth.get("relay_key_tier")) or "core"
        if want != have:
            return ""
    return stored


def _manual_env_key() -> str:
    """返回*用户显式设置*的 env key；hydrate/发放注入的产物不算（返回 ""）。

    provenance 的核心：只有用户手动设的 SUPERCLAW_RELAY_API_KEY 才享有"最高
    优先级逃生口"。本进程从缓存 hydrate 或发放写入的 env（带 HYDRATED 标记）是
    受治理产物，stored 变化时应被刷新，绝不能因 env!=stored 就被当成手动逃生口
    而绕过锁/缓存刷新（闭合跨进程 stale env，顾问 #4）。
    """
    env_key = (os.environ.get(RELAY_KEY_ENV) or "").strip()
    if not env_key or os.environ.get(RELAY_KEY_HYDRATED_ENV):
        return ""
    return env_key


def _set_hydrated_env(key: str) -> None:
    """把受治理 key 写进 env 并打 provenance 标记（标记它可被 stale 刷新）。"""
    os.environ[RELAY_KEY_ENV] = key
    os.environ[RELAY_KEY_HYDRATED_ENV] = "1"


def resolve_relay_api_key(*, tier: str | None = None) -> tuple[str | None, str]:
    """按链解析 relay key：返回 (key, source)，source ∈ env|stored|unset。

    手动 env（用户显式设置）享最高优先级；hydrate 产物的 env 一律按 stored 解析
    （展示/使用当前缓存值，而非可能已 stale 的 env 旧值）。

    档位（issue #452 / Codex 终审阻断项）：调用方传 ``tier`` 时，stored key 还须绑定**同一档位**
    才放行（``_owned_stored_key`` 的档位闸）——杜绝"ensure 后、pin key 前另一并发 run /
    ``ensure-key --tier`` 把同账号缓存换成别档 key，本 run 在 post-ensure resolve 阶段误用付费 key"
    的并发窗口。失配时 stored 视同不存在 → 返回 ``unset``，调用方 fail-closed（绝不用错档 key 起跑）。
    手动 env 逃生口不受 tier 限（显式用户自管 key）。``tier=None``（通用消费方：available / balance /
    usage / discovery）保持原行为，只看账号归属。
    """
    # 单次 auth snapshot：stored 与归属判定基于同一份数据，消除跨快照切号竞态（顾问第二轮）。
    auth = load_clawhunt_auth()
    manual = _manual_env_key()
    raw = auth.get("relay_api_key")
    stored = raw.strip() if isinstance(raw, str) and raw.strip() else ""
    # 账号隔离闸门：stored key 只有归属当前登录账号（且匹配档位）时才可用（防切号 / 切档串 key）。
    # 手动 env 逃生口不受此限（它本就是显式越权口，见 _manual_env_key）。
    owned_stored = _owned_stored_key(auth, tier=tier)
    if manual and manual != stored:
        return manual, "env"
    if owned_stored:
        return owned_stored, "stored"
    if manual:
        return manual, "env"
    return None, "unset"


def hydrate_relay_environment() -> bool:
    """把缓存的 relay key 注入 SUPERCLAW_RELAY_API_KEY。

    登录态发放的 key 经此进入 env 通道（clawwork backend 经 resolve_relay_api_key
    读同一条链，手动 env 仍享最高优先级）。provenance 规则（闭合跨进程 stale env，
    顾问 #4 第三/四轮）：
      - 用户显式 env（无 HYDRATED 标记）：绝不覆盖；
      - 本进程 hydrate 产物（有标记）且 stored 已变（另一进程 rotate）：刷新为新
        stored（old→new）；
      - 本进程 hydrate 产物且 stored 已被清空（另一进程 logout/clear）：清掉 stale
        env + 标记（old→unset），绝不把已吊销 key 继续传给 backend；
      - 无 env：注入 stored 并打标记。
    """
    # 账号隔离：失配（切号）的 stored 视同不存在 → 触发下面清掉 stale hydrated env，
    # 杜绝把账号 A 的 key 注入到账号 B 的进程 env（顾问评审：切号 env 污染——
    # save_clawhunt_auth 结尾会调本函数，B 登录写入瞬间即清掉 A 残留的 hydrated key）。
    # 单次 snapshot 判定，消除跨快照竞态（顾问第二轮）。
    stored = _owned_stored_key(load_clawhunt_auth())
    cur = (os.environ.get(RELAY_KEY_ENV) or "").strip()
    is_hydrated = bool(os.environ.get(RELAY_KEY_HYDRATED_ENV))
    if cur:
        if is_hydrated and stored and cur != stored:
            _set_hydrated_env(stored)  # old→new
            return True
        if is_hydrated and not stored:
            # stored 被另一进程清空 → 清掉本进程 stale hydrated env（old→unset）
            os.environ.pop(RELAY_KEY_ENV, None)
            os.environ.pop(RELAY_KEY_HYDRATED_ENV, None)
            return True
        return False
    if stored:
        _set_hydrated_env(stored)
        return True
    return False


def _persist_relay_key(payload: dict[str, Any], *, owner: str | None, tier: str | None = None) -> None:
    key = payload.get("key")
    if not isinstance(key, str) or not key:
        raise RelayKeyError("RELAY_ENSURE_FAILED: 中转站响应缺少 key 明文")
    save_clawhunt_auth(
        {
            "relay_api_key": key,
            "relay_key_source": "auto",
            "relay_key_name": payload.get("name"),
            # 展示用前缀本地从明文重算,不存服务端给的值(展示层只信本地明文)
            "relay_key_prefix": _mask_key(key),
            # 账号归属：用 exchange 时刻的 snapshot owner（调用方传入），绝不在此重读当前
            # 账号——否则 exchange 与落盘之间若另一进程切号，会把 A 发的 key 误标成 B
            # （切号竞态，顾问第二轮）。owner 恒等于这把 key 实际发放所用 token 的账号。
            "relay_key_owner": owner,
            # 档位归属（issue #452）：这把 key 实际绑定的隐藏分组档位。规范化后落盘；
            # 缺失/非法 → None（merge 语义下删除该字段，表示绑 fail-safe core）。owned_stored
            # 据此判"切档复用"。owner 与 tier 是平行隔离维度，缺一会让切档/切号串 key。
            "relay_key_tier": _normalize_tier(tier),
        }
    )
    # 仅当这把 key 仍归属当前账号时才注入进程 env（打 provenance 标记，可被后续 stale
    # 刷新）；切号竞态下（owner != 当前账号）绝不把别账号的 key 注入 env，并清掉残留。
    if owner is not None and owner == _current_account_identity():
        _set_hydrated_env(key)
    else:
        os.environ.pop(RELAY_KEY_ENV, None)
        os.environ.pop(RELAY_KEY_HYDRATED_ENV, None)


def ensure_relay_key(
    *,
    rotate: bool = False,
    tier: str | None = None,
    client: RelayBridgeClient | None = None,
) -> dict[str, Any]:
    """确保 clawwork 可用的 relay key 存在，返回脱敏摘要（绝不含明文）。

    语义：``ensure`` 保证*本地存在*一把 key（幂等、廉价），不回源校验远端是否
    仍有效——远端失效由 clawwork 实际调用 LLMgate 时的 401 暴露，用户再
    ``rotate`` 自愈。``rotate=True`` 强制轮换（本地明文丢失 / 怀疑泄露的恢复路径）。

    解析优先级：env 手动覆盖（明确的逃生口，不受桥治理）> 本地缓存（已经过桥
    发放）> 自动 exchange+ensure（已登录）> fail-closed。

    并发：只有*用户显式*的 env 逃生口走锁外快速返回；hydrate/发放产物的 env 不算
    逃生口（带 provenance 标记），一律进锁——锁内重读缓存并 hydrate（会刷新被另一
    进程 rotate 改掉的 stale env）。这样既不会落盘/注入即将被吊销的旧 key，也不会
    把 stale 的 hydrate env 误当手动逃生口返回（顾问评审 #4）。

    档位（issue #452）：``tier`` 非空时按 ``superclaw-{tier}`` 隐藏分组发放——device id 追加
    tier 后缀使每档在中转站落独立 key，缓存按 (owner, tier) 命中。切档（缓存档位 != 当前 tier）
    视同未命中，走 exchange 重新发放绑新分组，绝不复用旧档 key（验收：切档换池）。tier 缺失/
    非法回落 fail-safe core。手动 env 逃生口不分档（用户自管其 key 的分组）。
    """
    # 纯手动 env 逃生口（用户显式设置，非 hydrate 产物）：不碰缓存 → 锁外返回
    manual_key = _manual_env_key()
    if manual_key and manual_key != _stored_key():
        if rotate:
            raise RelayKeyError(
                "RELAY_KEY_ENV_MANAGED: SUPERCLAW_RELAY_API_KEY 由环境变量手动管理，"
                "rotate 只适用于自动发放的 key；请改在发放方轮换后更新环境变量"
            )
        return {"source": "env", "ensured": False, "key_prefix": _mask_key(manual_key)}

    with _relay_provision_lock():
        # 锁内先刷新/清理 stale hydrated env（old→new 或 old→unset），再判缓存。
        # 这样 stored 无论被另一进程 rotate 改写还是 logout 清空，本进程 env 都不会
        # 残留已吊销 key（顾问 #4 第三/四轮）。
        if not rotate:
            hydrate_relay_environment()
            # 账号隔离：只有归属当前账号的 stored 才短路返回；失配（切号）则继续往下
            # 走 exchange+ensure，用当前账号重新发放，绝不复用别账号的 key。
            # 单次 snapshot 判定 + 展示同源，消除跨快照竞态（顾问第二/三轮）。
            auth_now = load_clawhunt_auth()
            # 档位维度：tier 非空时只有绑同档的 stored 才短路命中；切档继续往下 exchange 重发。
            stored_now = _owned_stored_key(auth_now, tier=tier)
            if stored_now:
                return _stored_summary(auth_now)
            # 锁内再判一次手动逃生口（罕见：env 才被用户显式设置）
            manual_now = _manual_env_key()
            if manual_now:
                return {"source": "env", "ensured": False, "key_prefix": _mask_key(manual_now)}

        # 单次 snapshot：access_token 与 owner 同源，确保落盘的 owner 恒等于实际发 key
        # 所用 token 的账号（消除 exchange↔落盘之间的切号竞态，顾问第二轮）。
        auth_snapshot = load_clawhunt_auth()
        raw_token = auth_snapshot.get("access_token")
        access_token = raw_token.strip() if isinstance(raw_token, str) and raw_token.strip() else None
        owner_at_exchange = _current_account_identity(auth_snapshot)
        if not access_token:
            _audit("fail_closed", error_code="RELAY_LOGIN_REQUIRED")
            raise RelayKeyError(
                "RELAY_LOGIN_REQUIRED: 未检测到 ClawHunt 登录态；先 `superclaw clawhunt account-login`，"
                f"或手动设置 {RELAY_KEY_ENV} 环境变量"
            )

        norm_tier = _normalize_tier(tier)
        # device id 追加规范化 tier 后缀：每档在中转站命名空间 superclaw-clawwork:{device_id}
        # 下落到独立 key（切档换池，对齐主站 _bridge_device_id）。tier 缺失/非法保持基础 device。
        device_id = _apply_tier_to_device_id(superclaw_device_id(create=True), norm_tier)
        own_client = client is None
        bridge = client or RelayBridgeClient()
        try:
            exchanged = bridge.exchange(access_token, device_id, tier=norm_tier)
            bridge_token = exchanged.get("bridge_token")
            if not isinstance(bridge_token, str) or not bridge_token:
                raise RelayKeyError("RELAY_EXCHANGE_REJECTED: 中转站未返回 bridge token")
            rotated = rotate
            if rotate:
                result = _rotate_with_self_heal(bridge, bridge_token, device_id, owner=owner_at_exchange)
            else:
                result = bridge.ensure_key(bridge_token)
                if not result.get("created"):
                    # 服务端已有同名 key 但本地无明文（明文只在创建时返回一次）：
                    # 唯一恢复路径是轮换，绝不能反复 ensure 期待拿回明文。
                    result = _rotate_with_self_heal(bridge, bridge_token, device_id, owner=owner_at_exchange)
                    rotated = True
            _persist_relay_key(result, owner=owner_at_exchange, tier=norm_tier)
            summary = {
                "source": "auto",
                "ensured": True,
                "rotated": rotated,
                # 前缀本地从明文重算,不回显服务端给的 key_prefix 字段(顾问 #3)
                "key_prefix": _mask_key(result.get("key")),
                "key_name": _safe_text(result.get("name")),
                "quota_limit": result.get("quota_limit"),
                "rate_limit": result.get("rate_limit"),
                "expires_at": result.get("expires_at"),
                "device_id": device_id,
                "account_created": bool(exchanged.get("account_created")),
                # 这把 key 实际绑定的档位 + 隐藏分组 slug（验收：摘要/status 可见 superclaw-plus）。
                "tier": norm_tier,
                "group_slug": _group_slug_for_tier(norm_tier),
            }
            _audit(
                "rotated" if rotated else "provisioned",
                device_id=device_id,
                source="auto",
                key_prefix=result.get("key"),
                key_name=result.get("name"),
                key_id=result.get("id"),
                quota_limit=result.get("quota_limit"),
                rate_limit=result.get("rate_limit"),
                expires_at=result.get("expires_at"),
                account_created=bool(exchanged.get("account_created")),
                # 账号归属进审计：用 exchange 时刻的 snapshot owner（与落盘一致），
                # 账务可据此归因这把 key 发给了哪个登录账号。
                account_owner=owner_at_exchange,
                # 档位进审计：账务据此归因这把 key 绑定的计费分组（superclaw-{tier}）。
                tier=norm_tier,
            )
            return summary
        finally:
            if own_client:
                bridge.close()


def _rotate_with_self_heal(
    bridge: RelayBridgeClient, bridge_token: str, device_id: str, *, owner: str | None
) -> dict[str, Any]:
    """rotate，并对*请求可能已提交*的网络错误自愈。

    自愈边界（顾问评审 #2 + 第三轮，避免误清有效 key / 误清切号后他账号 key）：只在
    RELAY_RESPONSE_LOST（请求可能已到服务端、只是响应丢失——服务端可能已吊销旧 key）时，
    且本地 key 确为 auto 发放、*且归属仍是本次 rotate 发起的账号 owner* 时，才清本地 auto
    key 迫使下次 ensure 重发。RELAY_UNREACHABLE（请求根本没发出）绝不清；归属已切到别账号
    （owner 不匹配）也绝不清——那是当前账号的有效 key，清了会破坏其缓存（顾问第三轮）。
    """
    # 捕获 pre-rotate 状态：自愈条件清以 rotate *前* 的 (source, owner, key) 为准，而非
    # rotate 失败后再读——避免同账号在 rotate 进行中并发写入新 key 后，自愈误清掉那把新 key
    # （顾问第五轮非阻断）。owner 仍以本次 exchange 的 owner_at_exchange 为权威。
    pre = load_clawhunt_auth()
    pre_source = pre.get("relay_key_source")
    pre_owner = pre.get("relay_key_owner")
    pre_key = pre.get("relay_api_key")
    try:
        return bridge.rotate_key(bridge_token)
    except RelayKeyError as exc:
        if exc.code != "RELAY_RESPONSE_LOST":
            raise  # 请求没发出（UNREACHABLE 等）→ 远端状态未变，绝不清
        if pre_source != "auto":
            raise  # 非 auto（imported / 无）→ 无可清，保持 no-op，不审计
        if pre_owner != owner:
            # auto key 但归属已切到别账号（或无主）：绝不清当前账号的有效 key，仅留痕（顾问第三轮）。
            _audit(
                "rotate_self_heal",
                device_id=device_id,
                error_code="RELAY_RESPONSE_LOST",
                account_owner=owner,
                reason="skip_owner_mismatch" if pre_owner else "skip_owner_missing",
            )
            raise
        # 条件清：clear 前再次确认 stored 仍是 pre-rotate 的 (auto, owner, key)，
        # 防 check 后、clear 前另一进程切号写入别账号 key 被无条件清掉的 TOCTOU（顾问第四轮）。
        # 比较 key 本身是最强信号——切号后 key 变了即不清。残余窗口（helper re-load→clear）已
        # 缩到最小；彻底消除需让所有写 auth 文件的操作走同一把锁（跨模块重构，列 backlog；
        # 切号本身是罕见手动操作，后果仅本地缓存被清、下次 ensure 自动重发，非泄露）。
        cleared = _clear_relay_key_if_matches(
            expected_source="auto", expected_owner=owner, expected_key=pre_key,
        )
        _audit(
            "rotate_self_heal",
            device_id=device_id,
            error_code="RELAY_RESPONSE_LOST",
            account_owner=owner,
            reason="cleared_stale_auto_key" if cleared else "skip_changed_before_clear",
        )
        raise


def _stored_summary(auth: dict[str, Any] | None = None) -> dict[str, Any]:
    auth = auth if auth is not None else load_clawhunt_auth()
    raw = auth.get("relay_api_key")
    stored = raw.strip() if isinstance(raw, str) and raw.strip() else ""
    tier = _normalize_tier(auth.get("relay_key_tier"))
    return {
        "source": "stored",
        "ensured": False,
        # 前缀一律本地从明文 key 重算,绝不读 auth 文件里可能被污染的 prefix 字段；
        # 与归属判定用同一 snapshot，消除展示层二次 load 的快照错配（顾问第三轮非阻断）。
        "key_prefix": _mask_key(stored),
        "key_name": _safe_text(auth.get("relay_key_name")),
        # 这把缓存 key 绑定的档位 + 分组 slug（与 ensure 摘要同形，缓存命中路径也可见）。
        "tier": tier,
        "group_slug": _group_slug_for_tier(tier),
    }


def cached_tier_ceiling() -> str | None:
    """已登录账号的解锁上限档位（缓存值，issue #452 方案 B）。

    返回口径（与 backends 的越级 clamp 共用）：
      - **未登录**（无 access_token）→ ``None``：无"账号上限"概念，调用方一律不 clamp
        （手动 env key / 纯本地逃生口不该被档位拦）。
      - **已登录但 ceiling 缺失/非法** → ``"core"``：已登录账号至少受 core 上限约束；
        缺失通常是"老登录态、还没 fetch 过 /me"，按最低档兜底（疑似越级时 backends 会先
        ``refresh_tier_ceiling`` 刷新一次再判，避免误拦刚升级的用户）。
      - **已登录且 ceiling 合法** → 该规范化 tier（core/plus/max）。
    """
    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return None
    return _normalize_tier(auth.get("superclaw_tier_ceiling")) or "core"


def cached_plan() -> str | None:
    """已登录账号当前生效的 v18 卡包/服务档（``superclaw_plan``，缓存值）；未订阅/未登录 → None。

    与 :func:`cached_tier_ceiling` 同源、同生命周期：登录或 ``relay ensure-key`` 时
    :func:`refresh_tier_ceiling` 从 ``/api/auth/me`` 一并缓存 ``superclaw_plan``。纯缓存、
    网络无关；未登录或字段缺失（老登录态从未 fetch /me）/非法 → None。供设置页"当前套餐"展示。
    """
    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return None
    return _normalize_plan(auth.get("superclaw_plan"))


def cached_or_refresh_plan(*, client: Any = None) -> str | None:
    """当前套餐：已登录但 **从未缓存过** plan（字段缺失——刚切号/登录清掉、或老登录态从未取过
    /me）时刷新一次 /me，否则用缓存（网络无关）。未登录 → None。

    与 :func:`cached_or_refresh_tier_ceiling` 同构、解决 Codex 阻断 #2（"刷新余额"经 relay_usage
    走本函数 ⟹ 设置页有可靠的刷新路径）。判据用"字段是否存在"而非值：refresh 对未订阅落空串
    哨兵（字段存在、规范化为 None），故 ``"superclaw_plan" not in auth`` 唯一表示"从未取过"。
    """
    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return None
    # 缺 superclaw_plan **或** superclaw_is_admin（后者是本特性新加字段，老登录态可能只有 plan）
    # 都触发一次 /me 刷新——refresh_tier_ceiling 同一次把 plan + is_admin 一并补齐，否则
    # account_overview 会把 admin 的无限误标成 grant（Codex 阻断 #2）。
    if "superclaw_plan" not in auth or "superclaw_is_admin" not in auth:
        refresh_tier_ceiling(client=client)
        return cached_plan()
    return _normalize_plan(auth.get("superclaw_plan"))


def cached_or_refresh_tier_ceiling(*, client: Any = None) -> str | None:
    """解锁上限：已登录但**从未缓存过** ceiling 时刷新一次，否则用缓存（网络无关）。未登录→None。

    Codex 复审阻断项 #1：登录保存会清掉旧 ceiling（``save_clawhunt_auth`` 切号清除），若不
    在消费侧补刷新，刚登录的 plus/max 用户默认 run 会绑 core、``/api/relay/packages`` 也会把
    plus/max 误标 locked。故 backends 默认档 + 套餐端点用本函数：``superclaw_tier_ceiling`` 字段
    缺失（刚登录 / 升级前的旧 auth）才触网刷新一次（refresh 成功即便落 'core' 也算已缓存），字段
    一旦存在即纯缓存——**仅首次触网，之后零网络**。clamp 仍可在疑似越级时二次刷新纠正升级。
    """
    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return None
    if "superclaw_tier_ceiling" not in auth:
        return refresh_tier_ceiling(client=client)
    return _normalize_tier(auth.get("superclaw_tier_ceiling")) or "core"


def refresh_tier_ceiling(*, client: Any = None) -> str | None:
    """从主站 ``GET /api/auth/me`` 读账号解锁上限 tier 并缓存（issue #452 方案 B）。

    与服务端/主站契约对齐：``/api/auth/me`` 的 ``tier`` 字段 = 用户已购档位（小写
    core/plus/max，未持卡为 null）。返回规范化上限或 ``None``（未登录）。**best-effort**：
      - 未登录 → ``None``，不触网。
      - ``/me`` 非 200（网络/鉴权抖动）→ 保留并返回**已缓存**上限，绝不因一次抖动把付费
        用户降级到 core（只 ``debug`` log，不抛）。
      - ``/me`` 200：``tier`` 合法 → 落该档；``tier`` 为 null/非法（未持卡）→ 落 ``core``
        （显式落盘以区分"已确认 core"与"从未 fetch"）。
    ``client`` 注入供测试（``ClawHuntAccountClient`` 或其替身）。
    """
    token = saved_clawhunt_access_token()
    if not token:
        return None
    from superclaw.clawhunt_auth import ClawHuntAccountClient

    # 短超时：ceiling 刷新是 best-effort，绝不为它久等阻塞 clawwork run / 套餐列表（默认 20s 太长）。
    api = client or ClawHuntAccountClient(timeout=4.0)
    try:
        payload = api.me(token)
    except Exception as exc:  # 网络/解析失败：best-effort 保留缓存上限
        logger.debug("tier_ceiling_refresh_failed type=%s", type(exc).__name__)
        return cached_tier_ceiling()
    if not (isinstance(payload, dict) and payload.get("ok")):
        status = payload.get("status_code") if isinstance(payload, dict) else "?"
        logger.debug("tier_ceiling_refresh_non_ok status=%s", status)
        return cached_tier_ceiling()
    body = payload.get("body")
    resolved = (_normalize_tier(body.get("tier")) if isinstance(body, dict) else None) or "core"
    # 一并缓存 v18 卡包档位（``superclaw_plan``）：同一次 /me 取回，供设置页"当前套餐"展示。
    # 用 **空串哨兵** 表示"已确认未订阅"——save_clawhunt_auth 对 None 会 pop（无法区分"已取过
    # 但无订阅"与"从未取 /me"），落 "" 则字段存在但规范化为 None，使 cached_or_refresh_plan 能据
    # "字段是否存在"判断要不要刷新。降级（advanced→无）也由此正确覆盖成 ""。
    plan = (_normalize_plan(body.get("superclaw_plan")) if isinstance(body, dict) else None) or ""
    # is_admin 也一并缓存（同一次 /me）：account_overview 据此把"无限"权益的来源标成 admin
    # 旁路而非购买套餐（entitlement_source），避免把管理员无限误读成已买套餐。只认真实 bool
    # True（防上游脏值 "false" 字符串被 bool() 判成 True → 误标 admin，Codex 复审项）。
    is_admin = (body.get("is_admin") is True) if isinstance(body, dict) else False
    save_clawhunt_auth({
        "superclaw_tier_ceiling": resolved,
        "superclaw_plan": plan,
        "superclaw_is_admin": "1" if is_admin else "",
    })
    return resolved


def cached_is_admin() -> bool:
    """已登录账号是否管理员（缓存值，来自 /me 的 is_admin）。未登录/未缓存 → False。"""
    auth = load_clawhunt_auth()
    token = auth.get("access_token")
    if not (isinstance(token, str) and token.strip()):
        return False
    return auth.get("superclaw_is_admin") == "1"


def _tier_rank(tier: Any) -> int | None:
    """规范 tier 的档位序（core=0 < plus=1 < max=2）；非标准 → None。"""
    norm = _normalize_tier(tier)
    if not norm:
        return None
    from superclaw.relay_packages import SUPERCLAW_BRIDGE_TIERS

    return SUPERCLAW_BRIDGE_TIERS.index(norm)


def check_tier_within_ceiling(
    selected_tier: Any, *, refresh_client: Any = None
) -> tuple[bool, str | None, str | None]:
    """所选档位是否 ≤ 账号解锁上限（issue #452 方案 C：硬上限 clamp，业主拍板）。

    返回 ``(allowed, ceiling, selected_norm)``，单一裁决口径供 backends/cli 共用：
      - **未登录**（ceiling=None）→ allowed：无账号上限概念，交 LLMgate/余额兜底，绝不本地拦。
      - **非标准档**（动态套餐 / 裸模型 / None，``selected_norm`` 为 None）→ allowed：不参与
        clamp，原样下放由下游 fail-safe（绝不把未知值误判越级）。
      - **标准档**：``rank(selected) ≤ rank(ceiling)`` 才 allowed。
    防 stale 误拦：仅当**疑似越级**（selected > 缓存 ceiling）时才 ``refresh_tier_ceiling``
    触网刷新一次再判——刚升级、本地 ceiling 还旧的用户据此放行；正常 ≤ 上限的请求零触网。
    """
    selected_norm = _normalize_tier(selected_tier)
    ceiling = cached_tier_ceiling()
    if selected_norm is None or ceiling is None:
        return True, ceiling, selected_norm
    sel_rank = _tier_rank(selected_norm)
    if sel_rank is not None and _tier_rank(ceiling) is not None and sel_rank <= _tier_rank(ceiling):
        return True, ceiling, selected_norm
    # 疑似越级：刷新一次最新上限再判，避免误拦刚升级、本地 ceiling 仍 stale 的用户。
    refreshed = refresh_tier_ceiling(client=refresh_client)
    ceiling = refreshed or ceiling
    ceiling_rank = _tier_rank(ceiling)
    allowed = sel_rank is not None and ceiling_rank is not None and sel_rank <= ceiling_rank
    return allowed, ceiling, selected_norm


def is_tier_locked(tier: Any, ceiling: Any) -> bool:
    """档位 ``tier`` 是否被解锁上限 ``ceiling`` 锁定（越级）。**纯比较、零副作用、不触网**。

    供表层（API ``/api/relay/packages``）批量给套餐打 ``locked`` 标记，让前端零计算地灰显
    越级档——tier 序裁决留在内核（前端不得自造 core<plus<max，CLI 唯一事实源 + 铁律第 6 条）。
    与 ``check_tier_within_ceiling`` 的差别：后者会在疑似越级时触网刷新一次，这里**永不**触网
    （批量标注 N 个套餐不能各刷一次）。口径：
      - ``ceiling`` 为 None（未登录）→ 一律不锁（无账号上限概念）。
      - 非标准 tier / ceiling（动态套餐 / 裸值）→ 不锁（不参与档位序）。
      - 标准档：``rank(tier) > rank(ceiling)`` 即锁定。
    """
    if ceiling is None:
        return False
    tier_rank, ceiling_rank = _tier_rank(tier), _tier_rank(ceiling)
    if tier_rank is None or ceiling_rank is None:
        return False
    return tier_rank > ceiling_rank


def clear_relay_key() -> bool:
    """清除本地缓存的 relay key（不触网；远端吊销请用 rotate 或网页端）。"""
    auth = load_clawhunt_auth()
    had = bool(auth.get("relay_api_key"))
    prior_key = auth.get("relay_api_key")  # 清前明文，仅用于审计（落盘前会脱敏）
    save_clawhunt_auth(
        {
            "relay_api_key": None,
            "relay_key_source": None,
            "relay_key_name": None,
            "relay_key_prefix": None,
            # 必须一并清归属：save_clawhunt_auth 是 merge 语义，残留的 relay_key_owner
            # 会被后续写入的 ownerless key 继承、被归属校验误判可信（顾问第二轮阻断项）。
            "relay_key_owner": None,
            # 同理一并清档位标签：残留 relay_key_tier 会被后续 ownerless/新档 key 继承，
            # 让 owned_stored 把绑了别档的旧 key 误判为命中当前档（issue #452 切档隔离）。
            "relay_key_tier": None,
        }
    )
    os.environ.pop(RELAY_KEY_ENV, None)
    os.environ.pop(RELAY_KEY_HYDRATED_ENV, None)
    if had:
        _audit("cleared", key_prefix=prior_key)
    return had


def _clear_relay_key_if_matches(
    *, expected_source: str, expected_owner: str | None, expected_key: Any
) -> bool:
    """仅当当前 stored 仍是预期的 (source, owner, key) 时才清除（条件清）。

    用于 rotate self-heal：防"check 通过后、clear 前另一进程切号写入别账号 key"被无条件
    清掉的 TOCTOU（顾问第四轮）。re-load 紧贴 clear 把残余窗口缩到最小，并比较 key 本身
    （最强信号：切号后 key 变了即不清）。完全消除需让所有写 auth 文件的操作走同一把锁
    （跨模块重构，列 backlog）。
    """
    auth = load_clawhunt_auth()
    if (
        auth.get("relay_key_source") == expected_source
        and auth.get("relay_key_owner") == expected_owner
        and auth.get("relay_api_key") == expected_key
    ):
        return clear_relay_key()
    return False


def relay_status() -> dict[str, Any]:
    """relay key 链当前状态（全部脱敏，只读无副作用，可直接打印/上 API）。"""
    key, source = resolve_relay_api_key()
    auth = load_clawhunt_auth()
    # 前缀一律本地从解析出的明文 key 重算,绝不读 auth 文件里的 prefix 字段
    prefix = _mask_key(key) if key else None
    # status 是只读命令：不触发 device-id 生成写盘（create=False）
    device_id = superclaw_device_id(create=False)
    # 展示*解析后*的 relay base（显式覆盖 > 按环境烤入默认），而非裸 os.environ——否则
    # baked 默认下 status 会误报 "unset" 而实际 balance/discovery 走的是 baked 端点（单一源）。
    from superclaw.environment import relay_base_url as _resolved_relay_base

    relay_base_display = _resolved_relay_base()
    # 当前缓存 key 绑定的档位 + 隐藏分组（验收：relay status 可见 key 绑 superclaw-plus）。
    bound_tier = _normalize_tier(auth.get("relay_key_tier"))
    return {
        "relay_key": "set" if key else "unset",
        "relay_key_source": source,
        "relay_key_prefix": prefix,
        "relay_key_name": _safe_text(auth.get("relay_key_name")),
        # base URL 展示一律脱敏：只回显 scheme://host[:port]，绝不带 path/query/userinfo
        # （RELAY_BASE_URL 若被误配成含 secret 的 ?token=... 也不会经 status 泄露，顾问）。
        "bridge_base_url": _mask_base_url(relay_bridge_base_url()),
        "relay_base_url": _mask_base_url(relay_base_display),
        "clawhunt_account": "set" if saved_clawhunt_access_token() else "unset",
        "device_id": device_id or "pending",
        "relay_key_tier": bound_tier,
        "relay_key_group_slug": _group_slug_for_tier(bound_tier),
        # 账号解锁上限（方案 B）：None=未登录（不 clamp）；core/plus/max=已登录上限。
        "tier_ceiling": cached_tier_ceiling(),
    }


# balance 端点 currency 的固定白名单：只放行已知币种码，绝不回显服务端反射的任意大写串
# （宽泛正则会放行 SECRET/APIKEY 之类被塞进 currency 的脏值，故用固定集合，顾问）。
_ALLOWED_CURRENCIES = frozenset({"USD", "EUR", "CNY", "JPY", "GBP", "AUD", "CAD", "HKD", "SGD"})


def _coerce_finite_amount(raw: object) -> float | None:
    """把服务端回显的金额/数值字段安全收敛为有限 float，否则 None。

    排除 bool（isinstance(int) 陷阱）；float() 对超大整数抛 OverflowError 须捕获；
    NaN/Infinity 不放行（--json 会输出非标准 JSON，下游解析器可能拒绝）。供 balance /
    usage 两条只读查询共用，保证数值清洗口径一致。
    """
    if not isinstance(raw, (int, float)) or isinstance(raw, bool):
        return None
    try:
        candidate = float(raw)
    except (OverflowError, ValueError):
        return None
    return candidate if math.isfinite(candidate) else None


def relay_balance(*, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """查询 relay 账户余额（走解析链的 relay key 调 LLMgate /v1/user/balance）。

    用 resolve_relay_api_key() 解析出的 key 作 Bearer（解析链对所有 surface 一致，且账号
    隔离后恒为当前登录账号的 key，故查的就是当前账号余额）。relay base 经
    validate_relay_base_url 统一校验（https / 无 userinfo / 无 query/fragment / path），防 key
    被 exfil 到攻击者 host 或明文出网；follow_redirects=False + trust_env=False 防 3xx 泄露
    key / 不吃系统代理。返回脱敏摘要（余额/货币/激活态/key 前缀），绝不回显 key 明文或原始
    base。transport 注入口供测试。
    """
    key, source = resolve_relay_api_key()
    if not key:
        raise RelayKeyError(
            "RELAY_LOGIN_REQUIRED: 未检测到可用 relay key；先 `superclaw clawhunt account-login` "
            f"+ `superclaw relay ensure-key`，或手动设置 {RELAY_KEY_ENV}"
        )
    base = resolve_relay_base_url()
    # 规范化到契约 /v1/user/balance（base 已校验安全）：已以 /v1 结尾则直接追加，否则补 /v1。
    balance_url = f"{base}/user/balance" if base.endswith("/v1") else f"{base}/v1/user/balance"
    try:
        with httpx.Client(
            timeout=20.0, trust_env=False, follow_redirects=False, transport=transport
        ) as client:
            resp = client.get(
                balance_url,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            )
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise RelayKeyError(
            f"RELAY_BALANCE_UNREACHABLE: 无法查询余额（{type(exc).__name__}）；"
            f"请检查网络或 {RELAY_BASE_URL_ENV}"
        ) from exc
    if resp.status_code == 401:
        raise RelayKeyError(
            "RELAY_BALANCE_UNAUTHORIZED: relay key 未通过 LLMgate 鉴权（可能已失效/被吊销）；"
            "试 `superclaw relay rotate-key` 重新发放"
        )
    if resp.status_code != 200:
        raise RelayKeyError(f"RELAY_BALANCE_FAILED: 余额查询失败（HTTP {resp.status_code}）")
    try:
        body = resp.json()
    except ValueError:
        raise RelayKeyError("RELAY_BALANCE_FAILED: 余额响应非 JSON")
    if not isinstance(body, dict):
        raise RelayKeyError("RELAY_BALANCE_FAILED: 余额响应格式异常")
    # 脱敏摘要：绝不回显 key 明文。balance 经 _coerce_finite_amount 收敛为真有限数值
    # （排除 bool / 超大整数 OverflowError / NaN/Infinity），否则 None。
    balance = _coerce_finite_amount(body.get("balance"))
    # currency 走固定币种白名单：防服务端把 key/token 反射进 currency 被回显。
    raw_currency = body.get("currency")
    currency = (
        raw_currency
        if isinstance(raw_currency, str) and raw_currency in _ALLOWED_CURRENCIES
        else "USD"
    )
    return {
        "balance": balance,
        "currency": currency,
        # 只认真实 bool True：防 "false" 之类字符串被 bool() 判成 True。
        "is_active": body.get("is_active") is True,
        "relay_key_source": source,
        "relay_key_prefix": _mask_key(key),
    }


def relay_usage(*, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """查询当前 relay key 的累计消费与配额（走解析链的 key 调 LLMgate /v1/user/usage）。

    与 relay_balance 同一安全姿态：resolve_relay_api_key() 作 Bearer（账号隔离后恒为当前账号
    的 key，故查的就是当前 key 的真实花费）；validate_relay_base_url 统一校验 base（https /
    无 userinfo / 无 query/fragment / path）防 key 被 exfil 或明文出网；follow_redirects=False
    + trust_env=False 防 3xx 泄露 key、不吃系统代理。返回脱敏摘要（这把 key 的已消费 / 配额
    上限 / 账户余额 / 激活态 / key 前缀），绝不回显 key 明文或原始 base。credits_used 由
    LLMgate key 级配额机制在调用路径实时累加、按真实 usage 追账；quota_limit=0 表示不限额。
    transport 注入口供测试。
    """
    key, source = resolve_relay_api_key()
    if not key:
        raise RelayKeyError(
            "RELAY_LOGIN_REQUIRED: 未检测到可用 relay key；先 `superclaw clawhunt account-login` "
            f"+ `superclaw relay ensure-key`，或手动设置 {RELAY_KEY_ENV}"
        )
    base = resolve_relay_base_url()
    # 规范化到契约 /v1/user/usage（base 已校验安全）：已以 /v1 结尾则直接追加，否则补 /v1。
    usage_url = f"{base}/user/usage" if base.endswith("/v1") else f"{base}/v1/user/usage"
    try:
        with httpx.Client(
            timeout=20.0, trust_env=False, follow_redirects=False, transport=transport
        ) as client:
            resp = client.get(
                usage_url,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            )
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise RelayKeyError(
            f"RELAY_USAGE_UNREACHABLE: 无法查询消费（{type(exc).__name__}）；"
            f"请检查网络或 {RELAY_BASE_URL_ENV}"
        ) from exc
    if resp.status_code == 401:
        raise RelayKeyError(
            "RELAY_USAGE_UNAUTHORIZED: relay key 未通过 LLMgate 鉴权（可能已失效/被吊销）；"
            "试 `superclaw relay rotate-key` 重新发放"
        )
    if resp.status_code != 200:
        raise RelayKeyError(f"RELAY_USAGE_FAILED: 消费查询失败（HTTP {resp.status_code}）")
    try:
        body = resp.json()
    except ValueError:
        raise RelayKeyError("RELAY_USAGE_FAILED: 消费响应非 JSON")
    if not isinstance(body, dict):
        raise RelayKeyError("RELAY_USAGE_FAILED: 消费响应格式异常")
    # 三个数值字段统一经 _coerce_finite_amount 清洗（排除 bool / OverflowError / NaN/Inf），
    # 缺失或异常一律 None（CLI 渲染为 unknown），绝不把脏值原样回显。
    credits_used = _coerce_finite_amount(body.get("key_credits_used"))
    quota_limit = _coerce_finite_amount(body.get("key_quota_limit"))
    account_balance = _coerce_finite_amount(body.get("account_balance"))
    # currency 走固定币种白名单：防服务端把 key/token 反射进 currency 被回显。
    raw_currency = body.get("currency")
    currency = (
        raw_currency
        if isinstance(raw_currency, str) and raw_currency in _ALLOWED_CURRENCIES
        else "USD"
    )
    return {
        "key_credits_used": credits_used,
        "key_quota_limit": quota_limit,
        "account_balance": account_balance,
        "currency": currency,
        # 只认真实 bool True：防 "false" 之类字符串被 bool() 判成 True。
        "is_active": body.get("is_active") is True,
        # v18 当前生效卡包/服务档（basic/standard/advanced，未订阅 None）：设置页"当前套餐"
        # 数据源。用 cached_or_refresh_plan ⟹ "刷新余额"是可靠的刷新路径（首次/切号后 best-effort
        # 拉一次 /me，之后纯缓存）；额度进度仍由上面的 credits_used/quota_limit 给。
        "superclaw_plan": cached_or_refresh_plan(),
        "relay_key_source": source,
        "relay_key_prefix": _mask_key(key),
    }


def relay_package_models(
    tier: str, *, transport: httpx.BaseTransport | None = None, client: Any = None
) -> dict[str, Any]:
    """列出某套餐档位（core/plus/max）下可用的具体模型，供 chat composer 的 clawwork 二级
    模型选择器用（第一级选套餐、第二级选该套餐内的模型）。

    LLMgate ``/v1/models`` 按 key 所属分组收窄，故先 ``ensure_relay_key(tier=)`` 把 key 绑到该
    tier（复用 per-(account,tier) 缓存——仅首次/换号 provision，之后零 rotate），再带该 key 查
    ``/v1/models``，返回的即 ``superclaw-{tier}`` 组的模型 id 列表。与 relay_usage 同一安全姿态
    （base 校验 / trust_env=False / follow_redirects=False / 绝不回显 key 明文）。tier 非法 /
    未登录 / 网络失败一律抛 RelayKeyError（端点 fail-soft 成 ok=false，绝不拖垮 composer）。
    ``transport``（/v1/models GET）与 ``client``（ensure 的 bridge 客户端）注入口供测试。
    """
    norm = _normalize_tier(tier)
    if not norm:
        raise RelayKeyError(
            f"RELAY_PACKAGE_INVALID: 未知套餐档位 {tier!r}（仅 core/plus/max）",
            code="RELAY_PACKAGE_INVALID",
        )
    # 绑 key 到该档（复用缓存；未登录 / 验真失败会从 ensure 抛 RelayKeyError）。
    ensure_relay_key(tier=norm, client=client)
    key, source = resolve_relay_api_key(tier=norm)
    if not key:
        raise RelayKeyError(
            "RELAY_LOGIN_REQUIRED: 未检测到可用 relay key；先 `superclaw clawhunt account-login` "
            f"+ `superclaw relay ensure-key`，或手动设置 {RELAY_KEY_ENV}"
        )
    base = resolve_relay_base_url()
    models_url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
    try:
        with httpx.Client(
            timeout=20.0, trust_env=False, follow_redirects=False, transport=transport
        ) as http:
            resp = http.get(
                models_url,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            )
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise RelayKeyError(
            f"RELAY_PACKAGE_MODELS_UNREACHABLE: 无法查询套餐模型（{type(exc).__name__}）；"
            f"请检查网络或 {RELAY_BASE_URL_ENV}"
        ) from exc
    if resp.status_code == 401:
        raise RelayKeyError(
            "RELAY_PACKAGE_MODELS_UNAUTHORIZED: relay key 未通过 LLMgate 鉴权（可能已失效/被吊销）"
        )
    if resp.status_code != 200:
        raise RelayKeyError(
            f"RELAY_PACKAGE_MODELS_FAILED: 套餐模型查询失败（HTTP {resp.status_code}）"
        )
    try:
        body = resp.json()
    except ValueError:
        raise RelayKeyError("RELAY_PACKAGE_MODELS_FAILED: 模型响应非 JSON")
    # Fail-closed on a MALFORMED envelope (Codex adversarial finding #4): an OpenAI-style
    # /v1/models response always carries a ``data`` LIST. A non-dict body, a missing
    # ``data`` key, or a ``data`` that is not a list is a protocol error — raise, never
    # silently coerce it into ``models: []`` (which would masquerade a broken upstream as
    # "this tier has no models"). A genuine ``{"data": []}`` IS a valid empty group and
    # passes through as an empty list.
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        raise RelayKeyError(
            "RELAY_PACKAGE_MODELS_FAILED: 模型响应结构异常（缺少 data 列表）"
        )
    data = body["data"]
    models: list[str] = []
    for entry in data:
        mid = entry.get("id") if isinstance(entry, dict) else None
        if isinstance(mid, str) and mid.strip() and mid.strip() not in models:
            models.append(mid.strip())
    return {
        "ok": True,
        "tier": norm,
        "group_slug": _group_slug_for_tier(norm),
        "models": models,
        "relay_key_source": source,
        "relay_key_prefix": _mask_key(key),
    }


def clawhunt_entitlement(*, client: Any = None) -> dict[str, Any]:
    """主站 ``GET /api/agent-chat/usage`` 的有效权益/额度视图（与网页 "Pro · unlimited" 徽章
    同源）。返回脱敏摘要：是否无限、免费次数剩余/上限、已购积分、是否试用。**best-effort**：
    未登录 → ``{"ok": False, "logged_in": False}``；网络/非 200/脏响应 → ``{"ok": False}``。
    绝不抛、绝不回显 token。``client`` 注入供测试。
    """
    token = saved_clawhunt_access_token()
    if not token:
        return {"ok": False, "logged_in": False}
    from superclaw.clawhunt_auth import ClawHuntAccountClient

    api = client or ClawHuntAccountClient(timeout=4.0)
    try:
        payload = api.agent_chat_usage(token)
    except Exception as exc:  # 网络/解析失败：best-effort，绝不拖垮 account_overview
        logger.debug("entitlement_fetch_failed type=%s", type(exc).__name__)
        return {"ok": False, "logged_in": True}
    body = payload.get("body") if isinstance(payload, dict) else None
    if not (isinstance(payload, dict) and payload.get("ok") and isinstance(body, dict)):
        return {"ok": False, "logged_in": True}

    def _int(v: object) -> int | None:
        # bool 是 int 子类——显式排除，避免把 True/False 当 1/0 计数。
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    return {
        "ok": True,
        "logged_in": True,
        # 只认真实 bool True（防 "false" 字符串被 bool() 判真）。
        "unlimited": body.get("unlimited") is True,
        "free_chats_remaining": _int(body.get("free_chats_remaining")),
        "free_chat_limit": _int(body.get("free_chat_limit")),
        "chat_credits": _coerce_finite_amount(body.get("chat_credits")),
        "trial_active": bool(body.get("superclaw_trial_expires_at")),
    }


def account_overview(
    *, transport: httpx.BaseTransport | None = None, client: Any = None
) -> dict[str, Any]:
    """设置页"账户信息"的归一化聚合（内核单一收口，表层只消费、不自拼 union）。

    分源三块、语义绝不混（updatePRDv18 + 顾问设计裁定）：
      - ``billing_plan``：买了哪个 v18 卡包（``superclaw_plan``，未购/admin = None）。
      - ``entitlement`` / ``entitlement_source``：当前有效权益及其来源——把"admin / 试用 / legacy
        无限"与"购买套餐"区分开，绝不把前者伪装成已购套餐（这正是 admin 账号显示 superclaw_plan
        =None 却仍 unlimited 的根因）。
      - ``relay``：LLMgate 自费 key 的用量/余额（best-effort，无 key 时 ok=false）。
    所有子查询 best-effort；任一失败不拖垮其余。绝不回显 token / key 明文（沿用各子查询脱敏）。
    """
    logged_in = bool(saved_clawhunt_access_token())
    # 各子查询独立 best-effort：cached_or_refresh_plan 触网刷新失败也不该让整个聚合崩溃
    # （顾问健壮性项）——异常降级到纯缓存的 cached_plan()，绝不向上抛。
    try:
        billing_plan = cached_or_refresh_plan(client=client)
    except Exception as exc:
        logger.debug("account_overview plan refresh failed type=%s", type(exc).__name__)
        billing_plan = cached_plan()
    ent = clawhunt_entitlement(client=client)
    is_admin = cached_is_admin()
    try:
        relay: dict[str, Any] = {"ok": True, **relay_usage(transport=transport)}
    except RelayKeyError as exc:
        relay = {"ok": False, "code": str(exc).split(":", 1)[0], "error": str(exc)}

    unlimited = bool(ent.get("unlimited")) if ent.get("ok") else False
    credits = ent.get("chat_credits") if ent.get("ok") else None

    # entitlement_source：必须解释"有效权益"的真实来源，与 entitlement 标签对齐。无限优先按
    # 其来源归类（admin/trial/grant）——绝不把"恰好也买过套餐"的无限误标成 subscription（购买
    # 事实已在独立的 billing_plan 行展示，权益来源行不该混淆，Codex 阻断 #3）。仅当有效权益就是
    # 所购套餐时才 subscription。
    if unlimited:
        source = "admin" if is_admin else ("trial" if ent.get("trial_active") else "grant")
    elif billing_plan:
        source = "subscription"
    elif isinstance(credits, (int, float)) and credits > 0:
        source = "payg"
    else:
        source = "free"

    # entitlement（有效权益展示标签）：无限 > 购买套餐 > 按量(有已购积分) > 免费。
    if unlimited:
        entitlement = "unlimited"
    elif billing_plan:
        entitlement = billing_plan
    elif isinstance(credits, (int, float)) and credits > 0:
        entitlement = "payg"
    else:
        entitlement = "free"

    return {
        "ok": True,
        "logged_in": logged_in,
        "billing_plan": billing_plan,        # basic/standard/advanced 或 None（"买了哪个套餐"）
        "entitlement": entitlement,          # unlimited / <plan> / free（"现在能用什么"）
        "entitlement_source": source,        # admin/trial/grant/subscription/payg/free
        "unlimited": unlimited,
        "free_chats_remaining": ent.get("free_chats_remaining") if ent.get("ok") else None,
        "free_chat_limit": ent.get("free_chat_limit") if ent.get("ok") else None,
        "chat_credits": credits,
        "relay": relay,                      # LLMgate 自费用量（含 account_balance 等，已脱敏）
    }
