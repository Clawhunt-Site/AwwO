"""Static trusted tools, mirroring the Node worker's tools.mjs.

Requests select tool IDs; they never supply code, schemas, network
destinations, filesystem paths, or command arguments.
"""

import json
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ToolInputError(ValueError):
    pass


def _bounded(value: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ToolInputError()
    if value != value or value in (float("inf"), float("-inf")) or abs(value) > 1e12:
        raise ToolInputError()
    return float(value)


def calculate(expression: str) -> float:
    if not isinstance(expression, str) or not expression or len(expression) > 256:
        raise ToolInputError()
    if re.search(r"[^0-9. +*/()\-\t]", expression):
        raise ToolInputError()
    tokens = re.findall(r"(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]", expression)
    if "".join(tokens) != re.sub(r"[ \t]", "", expression) or len(tokens) > 128:
        raise ToolInputError()

    state = {"at": 0}

    def atom(depth: int) -> float:
        if depth > 16:
            raise ToolInputError()
        token = tokens[state["at"]] if state["at"] < len(tokens) else None
        state["at"] += 1
        if token == "+":
            return atom(depth + 1)
        if token == "-":
            return -atom(depth + 1)
        if token == "(":
            value = sum_expr(depth + 1)
            if state["at"] >= len(tokens) or tokens[state["at"]] != ")":
                raise ToolInputError()
            state["at"] += 1
            return value
        if not token or not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)", token):
            raise ToolInputError()
        return _bounded(float(token))

    def product(depth: int) -> float:
        value = atom(depth)
        while state["at"] < len(tokens) and tokens[state["at"]] in ("*", "/"):
            op = tokens[state["at"]]
            state["at"] += 1
            rhs = atom(depth)
            value = value * rhs if op == "*" else value / rhs
        return value

    def sum_expr(depth: int) -> float:
        value = product(depth)
        while state["at"] < len(tokens) and tokens[state["at"]] in ("+", "-"):
            op = tokens[state["at"]]
            state["at"] += 1
            rhs = product(depth)
            value = value + rhs if op == "+" else value - rhs
        return value

    value = sum_expr(0)
    if state["at"] != len(tokens):
        raise ToolInputError()
    return 0.0 if value == 0 else value


def execute_tool(name: str, tool_input: dict) -> str:
    if not isinstance(tool_input, dict):
        raise ToolInputError()
    if name == "calculator":
        if list(tool_input.keys()) != ["expression"]:
            raise ToolInputError()
        return json.dumps({"value": calculate(tool_input["expression"])})
    if name == "current_time":
        if list(tool_input.keys()) != ["timeZone"]:
            raise ToolInputError()
        time_zone = tool_input["timeZone"] or "UTC"
        if not isinstance(time_zone, str) or len(time_zone) > 80:
            raise ToolInputError()
        if not re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z0-9_+-]+){0,2}", time_zone):
            raise ToolInputError()
        try:
            tz = ZoneInfo(time_zone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ToolInputError()
        now = datetime.now(timezone.utc)
        return json.dumps({"iso": now.isoformat(), "timeZone": time_zone, "local": now.astimezone(tz).isoformat()})
    raise ToolInputError()


def tool_definition_bytes(names: list[str]) -> int:
    total = 0
    for name in names:
        schema = TOOL_SCHEMAS[name]
        total += len(json.dumps(schema).encode("utf-8")) + 128
    return total


TOOL_SCHEMAS = {
    "calculator": {
        "name": "calculator",
        "description": "Calculate bounded arithmetic with decimal numbers, + - * / and parentheses.",
        "parameters": {
            "type": "object",
            "properties": {"expression": {"type": "string", "maxLength": 256}},
            "required": ["expression"],
            "additionalProperties": False,
        },
    },
    "current_time": {
        "name": "current_time",
        "description": "Return the current ISO UTC timestamp and optionally a validated IANA timezone display.",
        "parameters": {
            "type": "object",
            "properties": {"timeZone": {"type": ["string", "null"], "maxLength": 80}},
            "required": ["timeZone"],
            "additionalProperties": False,
        },
    },
}


def validate_tool_names(names) -> list[str]:
    if not isinstance(names, list) or len(names) > 2 or len(set(names)) != len(names):
        raise ToolInputError()
    for name in names:
        if not isinstance(name, str) or name not in TOOL_SCHEMAS:
            raise ToolInputError()
    return list(names)


def tool_metadata(name: str) -> dict:
    return {
        "id": name,
        "name": name,
        "type": "function",
        "readOnly": True,
        "description": TOOL_SCHEMAS[name]["description"],
        "contextTextBytes": tool_definition_bytes([name]),
    }
