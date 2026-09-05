"""SuperClaw relay 套餐（package / tier）目录 — 登录后展示用。

把 LLMgate 的**裸模型列表**抽象成 ClawHunt 主站已定义的 **super 套餐**：登录 ClawHunt
账户后，各表层（CLI / API / Web）展示的是 ``core`` / ``plus`` / ``max`` 这几个由 super 分组
预设好的套餐，而不是 relay 背后的真实模型 id。

设计移植自 ClawHunt ``clawproduct-hunt`` 后端的 ``utils/superclaw_tier.py`` +
``utils/llmgate_relay.py`` + ``api/agent_chat.py::_relay_packages()``，**只取其 LLMgate
套餐的使用/设计逻辑**：

  优先级 ① 动态目录 ``GET /api/v1/bridge/packages`` → ② 分组 ``GET /api/v1/groups``
  → ③ 硬编码默认（core/plus/max）。任何网络/解析失败一律 **fail-safe** 降级到默认，
  绝不外抛、绝不卡死 UI。

安全姿态与 :func:`relay_key.relay_balance` 一致：base 走 ``resolve_relay_base_url()``
（已过 ``validate_relay_base_url``，https / 无 userinfo / 无 query·fragment），
``trust_env=False`` 不吃系统代理、``follow_redirects=False`` 防 3xx 把可选 token 转发外泄；
``transport`` 注入口供测试。
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from superclaw.clawhunt_auth import saved_clawhunt_access_token
from superclaw.relay_key import (
    RelayKeyError,
    resolve_relay_api_key,
    resolve_relay_base_url,
)

logger = logging.getLogger(__name__)

# 套餐档位与隐藏 group slug 映射 —— 与 ClawHunt / LLMgate bridge 严格一致（小写）。
# LLMgate bridge 在 /api/auth/me 收严格小写 tier 并映射到隐藏的 superclaw-* key group。
SUPERCLAW_BRIDGE_TIERS: tuple[str, ...] = ("core", "plus", "max")
SUPERCLAW_BRIDGE_TIER_SET = frozenset(SUPERCLAW_BRIDGE_TIERS)
SUPERCLAW_RELAY_GROUP_SLUGS: dict[str, str] = {
    "core": "superclaw-core",
    "plus": "superclaw-plus",
    "max": "superclaw-max",
}

# 可选 admin token / 自定义目录路径 —— 沿用 ClawHunt env 契约名，不另造名字。
_PACKAGES_PATH_ENV = "CLAWHUNT_RELAY_PACKAGES_PATH"
_CATALOG_TOKEN_ENV = "CLAWHUNT_BRIDGE_CATALOG_TOKEN"
_GROUPS_TOKEN_ENV = "CLAWHUNT_RELAY_GROUPS_TOKEN"
_DEFAULT_PACKAGES_PATH = "bridge/packages"

# 单次只读查询的超时（秒）。套餐目录是配置元数据，不需要长超时。
_QUERY_TIMEOUT_SECONDS = 15.0


# --- 套餐归一化（纯函数，移植自 superclaw_tier.py）------------------------------

def default_relay_packages() -> list[dict[str, str]]:
    """硬编码默认套餐 floor（relay 未暴露动态目录时展示这个）。"""
    return [
        {"id": tier, "name": tier, "tier": tier, "group_slug": group_slug}
        for tier, group_slug in SUPERCLAW_RELAY_GROUP_SLUGS.items()
    ]


def _package_from_identifier(
    identifier: str,
    name: str | None = None,
    group_slug: str | None = None,
) -> dict[str, str] | None:
    """把一个标识符（tier 短名或 superclaw-* slug）归一化成套餐条目。

    只接受**已知** tier 或 ``superclaw-`` 前缀的 slug —— 拒绝 relay 回显的任意裸模型
    id（设计原则：永不向用户暴露 LLMgate 裸模型）。
    """
    raw = str(identifier or "").strip().lower()
    if not raw:
        return None
    if raw.startswith("superclaw-"):
        package_id = raw[len("superclaw-"):]
        slug = raw
    elif raw in SUPERCLAW_BRIDGE_TIER_SET:
        package_id = raw
        slug = SUPERCLAW_RELAY_GROUP_SLUGS[raw]
    else:
        return None
    if not package_id:
        return None
    label = str(name or package_id).strip() or package_id
    if package_id in SUPERCLAW_BRIDGE_TIER_SET:
        # 三个标准档位（core/plus/max）的路由 slug 是契约常量。catalog **不得改写**它们
        # （fail-closed：恶意/错配 catalog 不能把 plus 重定向到别的 group——既防把付费档位
        # 静默改道，也让"显示"与"执行"对标准档位恒一致，无需执行期再查 live。顾问对抗项 #3）。
        final_slug = SUPERCLAW_RELAY_GROUP_SLUGS[package_id]
    else:
        # 非标准（动态新增）套餐：catalog 可定义自己的 group_slug，但仍必须是 superclaw-*
        # 形态——否则 catalog 能把裸模型 id 塞进套餐（既回显到 CLI/API JSON，又会在执行用
        # 动态 packages 时直接路由到裸模型）。非 superclaw-* 一律回落 identifier 派生的安全
        # slug，永不让外部数据决定一个非 superclaw 的路由键（顾问对抗项 #6）。
        candidate_slug = str(group_slug or "").strip().lower()
        final_slug = candidate_slug if candidate_slug.startswith("superclaw-") else slug
    return {"id": package_id, "name": label, "tier": package_id, "group_slug": final_slug}


def _dedupe_packages(packages: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for package in packages:
        package_id = str(package.get("id") or "").strip().lower()
        if not package_id or package_id in seen:
            continue
        seen.add(package_id)
        out.append(package)
    return out


def packages_from_groups(groups: list[dict[str, Any]]) -> list[dict[str, str]]:
    """LLMgate ``/api/v1/groups`` 行 → 套餐选项（按 slug 归一化）。"""
    packages: list[dict[str, str]] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        slug = str(group.get("slug") or "").strip().lower()
        package = _package_from_identifier(slug, name=str(group.get("name") or ""), group_slug=slug)
        if package:
            packages.append(package)
    return _dedupe_packages(packages)


def packages_from_catalog(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """LLMgate 动态套餐目录（灵活 schema）→ 套餐选项。"""
    packages: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        identifier = (
            item.get("id")
            or item.get("package_id")
            or item.get("tier")
            or item.get("slug")
        )
        name = item.get("name") or item.get("display_name") or item.get("label")
        group_slug = item.get("group_slug") or item.get("slug")
        package = _package_from_identifier(
            str(identifier or ""),
            name=str(name or ""),
            group_slug=str(group_slug or ""),
        )
        if package:
            packages.append(package)
    return _dedupe_packages(packages)


def normalize_relay_package_id(value: str | None) -> str | None:
    """接受 tier 短名或 group slug，返回规范的套餐 tier id；都不是则 None。"""
    package = str(value or "").strip().lower()
    if package in SUPERCLAW_BRIDGE_TIER_SET:
        return package
    for tier, group_slug in SUPERCLAW_RELAY_GROUP_SLUGS.items():
        if package == group_slug:
            return tier
    return None


def normalize_package_id_from_options(
    value: str | None,
    packages: list[dict[str, str]],
) -> str | None:
    """在一份动态套餐列表里解析用户选择（id 或 slug）→ 套餐 id。"""
    package = str(value or "").strip().lower()
    if not package:
        return None
    for option in packages:
        option_id = str(option.get("id") or "").strip().lower()
        group_slug = str(option.get("group_slug") or "").strip().lower()
        if package in {option_id, group_slug}:
            return option_id
    return normalize_relay_package_id(package)


def relay_group_slug_for_package(
    package_id: str,
    packages: list[dict[str, str]] | None = None,
) -> str:
    """解析发给 LLMgate 的 group slug：选中套餐 ``plus`` → ``superclaw-plus``。

    优先用动态列表里该套餐自带的 ``group_slug``；缺失则回落到静态 tier→slug 映射；
    再不行原样返回（让 relay 自己 fail-closed 拒绝未知模型）。
    """
    normalized = str(package_id or "").strip().lower()
    for package in packages or []:
        if str(package.get("id") or "").strip().lower() == normalized:
            group_slug = str(package.get("group_slug") or "").strip().lower()
            if group_slug:
                return group_slug
            break
    return SUPERCLAW_RELAY_GROUP_SLUGS.get(normalized, normalized)


# --- LLMgate 实网查询（fail-safe）--------------------------------------------

def _api_v1_url(base: str, path: str) -> str:
    """由已校验的 relay base 拼出 ``/api/v1/{path}`` 管理面地址。

    relay base 形如 ``https://gate.clawhunt.site/v1``（OpenAI 面）。套餐目录/分组在
    **管理面** ``/api/v1/...``，所以先剥掉末尾 ``/v1`` 再拼。
    """
    base = base.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return f"{base}/api/v1/{path.lstrip('/')}"


def _get_json(url: str, headers: dict[str, str], *, transport: httpx.BaseTransport | None = None) -> Any:
    """单次只读 GET → JSON；非 200 或异常一律返回 None（fail-safe）。

    与 relay_balance 同款安全姿态：``trust_env=False`` 不吃系统代理、
    ``follow_redirects=False`` 防 3xx 把可选 token 转发到未校验目的地。
    """
    # 注：日志只记异常类型 / 状态码 / 已脱敏 base，绝不记 headers（含可选 admin token）
    # 或响应体——留排障线索但不泄敏（顾问 advisory：fail-safe 不应静默吞光诊断信息）。
    try:
        with httpx.Client(
            timeout=_QUERY_TIMEOUT_SECONDS,
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            resp = client.get(url, headers=headers)
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        logger.debug("relay package query transport error (%s); degrading", type(exc).__name__)
        return None
    if resp.status_code != 200:
        logger.debug("relay package query HTTP %s; degrading", resp.status_code)
        return None
    try:
        return resp.json()
    except ValueError:
        logger.debug("relay package query returned non-JSON; degrading")
        return None


def _fetch_catalog(base: str, *, transport: httpx.BaseTransport | None = None) -> list[dict[str, str]]:
    """动态套餐目录 ``GET /api/v1/{CLAWHUNT_RELAY_PACKAGES_PATH}``。"""
    path = (os.getenv(_PACKAGES_PATH_ENV, _DEFAULT_PACKAGES_PATH) or _DEFAULT_PACKAGES_PATH).strip().lstrip("/")
    if not path:
        path = _DEFAULT_PACKAGES_PATH
    headers: dict[str, str] = {"Accept": "application/json"}
    token = (os.getenv(_CATALOG_TOKEN_ENV) or "").strip()
    if token:
        headers["X-Bridge-Catalog-Token"] = token
    data = _get_json(_api_v1_url(base, path), headers, transport=transport)
    rows = _coerce_rows(data)
    return packages_from_catalog(rows) if rows else []


def _fetch_groups(base: str, *, transport: httpx.BaseTransport | None = None) -> list[dict[str, str]]:
    """LLMgate 分组 ``GET /api/v1/groups``。"""
    headers: dict[str, str] = {"Accept": "application/json"}
    token = (os.getenv(_GROUPS_TOKEN_ENV) or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = _get_json(_api_v1_url(base, "groups"), headers, transport=transport)
    if isinstance(data, list):
        return packages_from_groups([row for row in data if isinstance(row, dict)])
    return []


def _coerce_rows(data: Any) -> list[dict[str, Any]]:
    """兼容多种目录响应形状：裸 list / {packages|models|data: [...]}。"""
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        for key in ("packages", "models", "data"):
            rows = data.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    return []


def relay_packages(*, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """登录后展示用的 super 套餐目录。

    返回 ``{"packages":[{id,name,tier,group_slug}], "source": ..., "available": bool}``：

    - ``available`` = relay 已配置（base 可解析）**且**已登录。已登录的口径与
      ``ClawWorkBackend.available()`` 对齐：有缓存 relay key **或** 有 ClawHunt
      access_token（run() 会经 bridge 自动发放 key）都算已登录——否则"已登录但 key 未
      缓存"的用户会被错误地挡在套餐之外（顾问对抗项 #1）。
    - 已登录才发实网查询（groups/catalog 用可选 admin token，不需用户 key），优先级
      catalog → groups → 默认；未登录或查询无果一律返回硬编码默认 floor
      （``source="default"``），永不外抛。
    - ``source`` ∈ ``catalog`` | ``groups`` | ``default``，诚实标注套餐来源。

    ``transport`` 注入口供测试。
    """
    defaults = default_relay_packages()
    try:
        base = resolve_relay_base_url()
    except RelayKeyError:
        # relay 未配置 / base 非法：展示默认 floor，标记不可用。
        return {"packages": defaults, "source": "default", "available": False}

    key, _source = resolve_relay_api_key()
    # 已登录口径与 clawwork 后端可用性一致：缓存 key 或 ClawHunt access_token 均可。
    available = bool(key) or bool(saved_clawhunt_access_token())
    if not available:
        # 未登录：展示默认 floor 作预览，由表层据 available 提示登录。
        return {"packages": defaults, "source": "default", "available": False}

    catalog = _fetch_catalog(base, transport=transport)
    if catalog:
        return {"packages": catalog, "source": "catalog", "available": True}

    groups = _fetch_groups(base, transport=transport)
    if groups:
        return {"packages": groups, "source": "groups", "available": True}

    # 已登录但 relay 未暴露动态目录/分组（或查询被 fail-safe 吞掉）→ 默认 floor。
    # 留一条 debug 痕迹便于排障：诚实区分"relay 确实只有默认"与"查询失败降级"——
    # 非敏感（不含 key/base），不把降级粉饰成"成功拿到套餐"（顾问 advisory #4）。
    logger.debug("relay_packages: no dynamic catalog/groups exposed; serving default tier floor")
    return {"packages": defaults, "source": "default", "available": True}
