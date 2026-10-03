"""The curated Bedrock catalog (apps/bedrock-models.json) for the Python worker.

Mirrors apps/bedrock-catalog.ts and reads the same file and environment:
AWWO_BEDROCK_CATALOG (off|builtin), AWWO_BEDROCK_REGION, AWWO_BEDROCK_MODELS,
AWWO_BEDROCK_API_KEY and AWWO_PLATFORM_PROVIDERS.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from bedrock_bridge import BEARER, BEDROCK_REGIONS, valid_region

# The worker runs from the repository/release tree (apps/openai-agents-python-worker), where the
# shared catalog sits one level up; a copy next to this module (a packaged install) takes precedence.
CATALOG_PATHS = (Path(__file__).resolve().parent / "bedrock-models.json", Path(__file__).resolve().parent.parent / "bedrock-models.json")
PLATFORM_PROVIDERS = ("llmgate", "bedrock")
ENTRY_FIELDS = ("id", "name", "vendor", "target", "contextWindow", "maxTokens", "input", "tools", "runtime", "verified")
CATALOG_ID = re.compile(r"bedrock\.[a-z0-9][a-z0-9-]{0,62}")
TARGET = re.compile(r"(?:(?:global|us|eu|apac|jp|au|ca)\.)?[a-z0-9-]+\.[A-Za-z0-9.:-]{1,120}")
VENDOR = re.compile(r"[a-z][a-z0-9-]{0,31}")


class CatalogError(ValueError):
    pass


def _integer(value, minimum: int, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _valid_name(name) -> bool:
    if not isinstance(name, str) or not 1 <= len(name) <= 80:
        return False
    if any(unicodedata.category(char) in ("Cc", "Cf", "Cs") for char in name):
        return False
    return True


def parse_catalog_file(value) -> tuple:
    """The strictly validated catalog: (verified regions, entries in file order)."""
    def fail():
        raise CatalogError("The Bedrock model catalog is invalid")
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("models"), list) or not 1 <= len(value["models"]) <= 255:
        fail()
    regions = value.get("regions")
    if (not isinstance(regions, list) or not regions or len(set(map(str, regions))) != len(regions)
            or not all(isinstance(region, str) and valid_region(region) for region in regions)):
        fail()
    ids, targets, entries = set(), set(), []
    for e in value["models"]:
        if not isinstance(e, dict) or set(e) != set(ENTRY_FIELDS):
            fail()
        if (not isinstance(e["id"], str) or not CATALOG_ID.fullmatch(e["id"]) or e["id"] in ids
                or not _valid_name(e["name"]) or not isinstance(e["vendor"], str) or not VENDOR.fullmatch(e["vendor"])
                or not isinstance(e["target"], str) or not TARGET.fullmatch(e["target"]) or e["target"] in targets
                or not _integer(e["contextWindow"], 4096, 2_000_000) or not _integer(e["maxTokens"], 128, 32_768)
                or e["maxTokens"] + 256 >= e["contextWindow"]
                or not isinstance(e["input"], list) or not e["input"] or any(kind not in ("text", "image") for kind in e["input"]) or "text" not in e["input"]
                or not isinstance(e["tools"], bool) or e["runtime"] not in ("pi", "openai-agents")
                or (e["runtime"] == "openai-agents" and e["tools"] is not True)
                or not isinstance(e["verified"], str) or (e["verified"] and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", e["verified"]))):
            fail()
        ids.add(e["id"])
        targets.add(e["target"])
        entries.append(dict(e))
    return tuple(regions), tuple(entries)


def parse_catalog(value) -> tuple:
    """Strictly validated catalog entries, in file order."""
    return parse_catalog_file(value)[1]


_builtin: tuple | None = None


def _read_catalog_file(paths: tuple) -> tuple:
    global _builtin
    if _builtin is None or paths is not CATALOG_PATHS:
        path = next((candidate for candidate in paths if candidate.is_file()), None)
        if path is None:
            raise CatalogError("The Bedrock model catalog bedrock-models.json was not deployed with this worker")
        catalog = parse_catalog_file(json.loads(path.read_text(encoding="utf-8")))
        if paths is not CATALOG_PATHS:
            return catalog
        _builtin = catalog
    return _builtin


def read_catalog(paths: tuple = CATALOG_PATHS) -> tuple:
    return _read_catalog_file(paths)[1]


def read_catalog_regions(paths: tuple = CATALOG_PATHS) -> tuple:
    """The regions the built-in catalog was verified in."""
    return _read_catalog_file(paths)[0]


def parse_platform_providers(value: str | None) -> tuple:
    items = ["llmgate"] if value is None or not value.strip() else [item.strip() for item in value.split(",")]
    if any(item not in PLATFORM_PROVIDERS for item in items) or len(set(items)) != len(items) or "llmgate" not in items:
        raise CatalogError("AWWO_PLATFORM_PROVIDERS must list distinct values from llmgate, bedrock and include llmgate")
    return tuple(item for item in PLATFORM_PROVIDERS if item in items)


def platform_providers_in_use(policy: tuple, providers) -> tuple:
    """The platform destinations a worker's profiles reach: LLM Gate, plus Bedrock only when used."""
    used = set(providers)
    return tuple(item for item in policy if item == "llmgate" or item in used)


OPERATOR_ONLY_BEDROCK = ("Bedrock models use operator credentials; a worker with AWWO_CREDENTIAL_MODE=user "
                         "serves personal LLM Gate connections only")


def platform_health(llmgate_only: bool, providers: tuple) -> dict:
    if not llmgate_only:
        return {}
    return {"llmgateOnly": True} if len(providers) == 1 else {"platformOnly": True, "platformProviders": list(providers)}


def bedrock_region(env: dict) -> str:
    region = (env.get("AWWO_BEDROCK_REGION") or "").strip() or "us-east-1"
    if not valid_region(region):
        raise CatalogError("AWWO_BEDROCK_REGION must be one of " + ", ".join(BEDROCK_REGIONS))
    return region


def bedrock_api_key(env: dict, name: str = "AWWO_BEDROCK_API_KEY") -> str:
    key = (env.get(name) or "").strip()
    if key and not BEARER.fullmatch(key):
        raise CatalogError(f"{name} is not a valid Bedrock API key")
    return key


def catalog_selection(runtime: str, env: dict, entries: tuple | None = None, regions: tuple | None = None) -> list:
    """Entries the built-in catalog contributes to one worker, or none when it is off."""
    mode = (env.get("AWWO_BEDROCK_CATALOG") or "").strip()
    if mode in ("", "off"):
        return []
    if mode not in ("builtin", "builtin-all"):
        raise CatalogError("AWWO_BEDROCK_CATALOG must be off, builtin or builtin-all")
    entries = read_catalog() if entries is None else entries
    regions = read_catalog_regions() if regions is None else regions
    region = bedrock_region(env)
    # In another region the same IDs may be missing or need other inference profiles.
    if region not in regions:
        raise CatalogError(f"the built-in catalog is verified for {', '.join(regions)}; for {region} verify the models with "
                           "scripts/bedrock-catalog-check.py and configure them as explicit MODELS_JSON profiles")
    raw = (env.get("AWWO_BEDROCK_MODELS") or "").strip()
    if not raw:
        # An entry without a verified call (one that needs cross-region inference permission) is only
        # offered once the operator says the account can call it: builtin-all, or naming it explicitly.
        return [entry for entry in entries if entry["runtime"] == runtime and (mode == "builtin-all" or entry["verified"])]
    ids = [item.strip() for item in raw.split(",")]
    if any(not item for item in ids) or len(set(ids)) != len(ids):
        raise CatalogError("AWWO_BEDROCK_MODELS must be a comma list of distinct catalog ids")
    by_id = {entry["id"]: entry for entry in entries}
    for item in ids:
        if item not in by_id:
            raise CatalogError("AWWO_BEDROCK_MODELS names a model that is not in the Bedrock catalog")
        if runtime == "openai-agents" and not by_id[item]["tools"]:
            raise CatalogError("AWWO_BEDROCK_MODELS names a model without tool support for the OpenAI Agents runtime")
    return [entry for entry in entries if entry["id"] in ids]
