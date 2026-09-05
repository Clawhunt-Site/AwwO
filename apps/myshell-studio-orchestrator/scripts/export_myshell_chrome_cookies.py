#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


DEFAULT_CHROME_DIR = Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
DEFAULT_HOST_PATTERNS = ("%myshell.ai%", "%myshell.fun%", "%myshellstatic.com%")
REQUIRED_MYSHELL_ART_COOKIE_NAMES = ("ms_token",)


class CookieExportError(RuntimeError):
    pass


def _safe_storage_password() -> bytes:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "Chrome Safe Storage", "-w"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception as exc:
        raise CookieExportError("Could not read Chrome Safe Storage from Keychain") from exc
    password = result.stdout.strip()
    if not password:
        raise CookieExportError("Chrome Safe Storage password is empty")
    return password.encode("utf-8")


def _chrome_key(password: bytes) -> bytes:
    return PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=b"saltysalt", iterations=1003).derive(password)


def _unpad(value: bytes) -> bytes:
    if not value:
        return value
    padding = value[-1]
    if padding < 1 or padding > 16:
        return value
    return value[:-padding]


def _strip_chrome_host_key_prefix(decrypted: bytes, host_key: str) -> bytes:
    if not host_key or len(decrypted) <= 32:
        return decrypted
    digest = hashlib.sha256(host_key.encode("utf-8")).digest()
    if decrypted.startswith(digest):
        return decrypted[32:]
    return decrypted


def _decrypt_cookie_value(encrypted_value: bytes, key: bytes, host_key: str = "") -> str:
    if not encrypted_value:
        return ""
    payload = encrypted_value[3:] if encrypted_value.startswith(b"v10") or encrypted_value.startswith(b"v11") else encrypted_value
    decryptor = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    decrypted = _strip_chrome_host_key_prefix(_unpad(decryptor.update(payload) + decryptor.finalize()), host_key)
    return decrypted.decode("utf-8", errors="replace")


def _profiles(chrome_dir: Path, requested: list[str]) -> list[Path]:
    if requested:
        return [chrome_dir / profile for profile in requested]
    profiles: list[Path] = []
    for candidate in [chrome_dir / "Default", *sorted(chrome_dir.glob("Profile *"))]:
        if (candidate / "Cookies").exists():
            profiles.append(candidate)
    return profiles


def _read_profile_cookies(profile_dir: Path, key: bytes, host_patterns: tuple[str, ...]) -> list[dict[str, Any]]:
    cookie_db = profile_dir / "Cookies"
    if not cookie_db.exists():
        return []
    with tempfile.NamedTemporaryFile(prefix="myshell-cookies-", suffix=".sqlite3", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        shutil.copy2(cookie_db, tmp_path)
        where = " OR ".join("host_key LIKE ?" for _ in host_patterns)
        query = f"""
            SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
            FROM cookies
            WHERE {where}
            ORDER BY host_key, name
        """
        with sqlite3.connect(tmp_path) as connection:
            rows = connection.execute(query, host_patterns).fetchall()
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    cookies: list[dict[str, Any]] = []
    for host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite in rows:
        cookie_value = value or _decrypt_cookie_value(encrypted_value, key, str(host_key or ""))
        if not cookie_value:
            continue
        cookie: dict[str, Any] = {
            "name": name,
            "value": cookie_value,
            "domain": host_key,
            "path": path or "/",
            "secure": bool(is_secure),
            "httpOnly": bool(is_httponly),
        }
        if expires_utc:
            # Chromium stores microseconds since 1601-01-01. CDP accepts unix seconds.
            unix_seconds = int((int(expires_utc) / 1_000_000) - 11644473600)
            if unix_seconds > 0:
                cookie["expires"] = unix_seconds
        if samesite == 1:
            cookie["sameSite"] = "Lax"
        elif samesite == 2:
            cookie["sameSite"] = "Strict"
        elif samesite == 3:
            cookie["sameSite"] = "None"
        cookies.append(cookie)
    return cookies


def _dedupe(cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for cookie in cookies:
        key = (str(cookie.get("domain") or ""), str(cookie.get("path") or "/"), str(cookie.get("name") or ""))
        deduped[key] = cookie
    return list(deduped.values())


def _cookie_names(cookies: list[dict[str, Any]]) -> list[str]:
    return sorted({str(cookie.get("name") or "") for cookie in cookies if isinstance(cookie, dict) and cookie.get("name")})


def _missing_cookie_names(cookies: list[dict[str, Any]]) -> list[str]:
    names = set(_cookie_names(cookies))
    return [name for name in REQUIRED_MYSHELL_ART_COOKIE_NAMES if name not in names]


def _summary_from_export_result(result: dict[str, Any], output: str) -> dict[str, Any]:
    cookies = [cookie for cookie in result.get("cookies", []) if isinstance(cookie, dict)]
    return {
        "status": result["status"],
        "cookieCount": result["cookieCount"],
        "cookieNames": _cookie_names(cookies),
        "requiredCookieNames": list(REQUIRED_MYSHELL_ART_COOKIE_NAMES),
        "missingCookieNames": _missing_cookie_names(cookies),
        "profiles": result["profiles"],
        "output": output,
    }


def export_cookies(chrome_dir: Path, profiles: list[str], host_patterns: tuple[str, ...]) -> dict[str, Any]:
    key = _chrome_key(_safe_storage_password())
    profile_results: list[dict[str, Any]] = []
    all_cookies: list[dict[str, Any]] = []
    for profile_dir in _profiles(chrome_dir, profiles):
        cookies = _read_profile_cookies(profile_dir, key, host_patterns)
        profile_results.append(
            {
                "profile": profile_dir.name,
                "cookieCount": len(cookies),
                "cookieNames": _cookie_names(cookies),
                "missingCookieNames": _missing_cookie_names(cookies),
                "domains": sorted({str(cookie.get("domain") or "") for cookie in cookies}),
            }
        )
        all_cookies.extend(cookies)
    cookies = _dedupe(all_cookies)
    return {
        "status": "ready" if cookies else "missing",
        "cookieCount": len(cookies),
        "profiles": profile_results,
        "cookies": cookies,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Export MyShell cookies from local Chrome profiles without printing secret values.")
    parser.add_argument("--chrome-dir", default=str(DEFAULT_CHROME_DIR))
    parser.add_argument("--profile", action="append", default=[], help="Chrome profile name, e.g. Default or 'Profile 1'. Repeatable.")
    parser.add_argument("--host-like", action="append", default=[], help="SQLite LIKE pattern for host_key. Repeatable.")
    parser.add_argument("--output", help="Write cookie JSON array to this local file. Secret values are never printed.")
    parser.add_argument("--summary-json", action="store_true", help="Print machine-readable summary without cookie values.")
    args = parser.parse_args()

    host_patterns = tuple(args.host_like or DEFAULT_HOST_PATTERNS)
    result = export_cookies(Path(args.chrome_dir).expanduser(), args.profile, host_patterns)
    if args.output:
        output_path = Path(args.output).expanduser()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result["cookies"], ensure_ascii=False), encoding="utf-8")
        os.chmod(output_path, 0o600)
    summary = _summary_from_export_result(result, args.output or "")
    print(json.dumps(summary, indent=2, ensure_ascii=False) if args.summary_json else f"MyShell cookies: {summary['cookieCount']} ({summary['status']})")
    return 0 if result["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
