// AUTO-MIRRORED from schemas/superclaw-plugin.schema.json (canonical SuperClaw source).
// A drift test (super-plugin-manifest.test.ts) asserts this stays byte-identical.
// eslint-disable
export const SUPER_PLUGIN_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://superclaw.dev/schemas/superclaw-plugin.schema.json",
  "title": "SuperClaw Plugin Manifest",
  "x-superclaw-contract-version": 1,
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "id",
    "name",
    "version",
    "summary",
    "source",
    "runtime",
    "tools",
    "permissions",
    "acceptance",
    "commerce",
    "provenance"
  ],
  "properties": {
    "schema_version": { "$ref": "#/$defs/semver" },
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*)+$"
    },
    "name": { "type": "string", "minLength": 1 },
    "version": { "$ref": "#/$defs/semver" },
    "summary": { "type": "string", "minLength": 1, "maxLength": 240 },
    "logo": {
      "type": "string",
      "description": "Optional package-local logo image path for UI presentation. The runtime serves it from the verified plugin cache.",
      "pattern": "^(?!/)(?!.*\\.\\.)(?!.*//).+\\.(png|jpe?g|webp|svg)$"
    },
    "skill_origin": {
      "type": "boolean",
      "description": "True when this package was produced by `superclaw plugin import-skill` from a standard SKILL.md. A skill-origin plugin is surfaced in the marketplace's skill view; it carries no extra capability beyond returning its own prose."
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "clawhunt_problem_id", "developer_id"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["developer_upload", "clawhunt_delivery", "first_party"]
        },
        "clawhunt_problem_id": {
          "type": ["string", "null"],
          "minLength": 1
        },
        "developer_id": {
          "type": ["string", "null"],
          "minLength": 1
        }
      }
    },
    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "args", "transport", "mcp_protocol_versions", "platforms"],
      "properties": {
        "type": { "type": "string", "enum": ["mcp_sidecar", "external_mcp"] },
        "entrypoint": {
          "type": "string",
          "pattern": "^(?!/)(?!.*\\.\\.).+"
        },
        "command": {
          "type": "string",
          "minLength": 1,
          "pattern": "^[^/\\\\]+$",
          "description": "external_mcp only: a bare launcher NAME to spawn (e.g. npx/uvx/node), resolved on the operator PATH at runtime. Path separators / absolute paths are rejected so the manifest cannot point execution at an arbitrary on-disk binary."
        },
        "url": {
          "type": "string",
          "minLength": 1,
          "description": "external_mcp + sse/http transport only: the remote MCP endpoint."
        },
        "args": {
          "type": "array",
          "items": { "type": "string" }
        },
        "transport": { "type": "string", "enum": ["stdio", "sse", "http"] },
        "mcp_protocol_versions": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
        },
        "platforms": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string", "minLength": 3 }
        }
      },
      "allOf": [
        {
          "if": { "properties": { "type": { "const": "mcp_sidecar" } } },
          "then": {
            "required": ["entrypoint"],
            "properties": { "transport": { "const": "stdio" } }
          }
        },
        {
          "if": {
            "properties": {
              "type": { "const": "external_mcp" },
              "transport": { "const": "stdio" }
            }
          },
          "then": { "required": ["command"] }
        },
        {
          "if": {
            "properties": {
              "type": { "const": "external_mcp" },
              "transport": { "enum": ["sse", "http"] }
            }
          },
          "then": { "required": ["url"] }
        }
      ]
    },
    "tools": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/tool" },
      "uniqueItems": true
    },
    "permissions": {
      "type": "object",
      "additionalProperties": false,
      "required": ["filesystem", "network", "environment"],
      "properties": {
        "filesystem": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["mode", "scope"],
            "properties": {
              "mode": { "type": "string", "enum": ["read", "write", "readwrite"] },
              "scope": { "type": "string", "enum": ["workspace", "artifact_dir", "plugin_cache"] }
            }
          }
        },
        "network": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["host"],
            "properties": {
              "host": {
                "type": "string",
                "not": { "const": "*" }
              }
            }
          }
        },
        "environment": {
          "type": "array",
          "items": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" }
        }
      }
    },
    "configuration": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "secrets": {
          "type": "array",
          "items": { "$ref": "#/$defs/secret_descriptor" }
        },
        "settings": {
          "type": "array",
          "items": { "$ref": "#/$defs/setting_descriptor" }
        }
      }
    },
    "clawhunt_account_bridge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "token_env", "default_config_url", "default_panel_url"],
      "properties": {
        "type": { "type": "string", "enum": ["pay_switch_agent_token"] },
        "token_env": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "config_url_env": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "panel_url_env": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "device_id_env": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "default_config_url": { "type": "string", "format": "uri" },
        "default_panel_url": { "type": "string", "format": "uri" },
        "plugin_id": { "type": "string", "minLength": 1 },
        "device_id": { "type": "string", "minLength": 1 },
        "superclaw_install_id": { "type": "string", "minLength": 1 }
      }
    },
    "acceptance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "tests", "evidence_fixtures", "latency_budget_ms"],
      "properties": {
        "level": { "type": "string", "enum": ["L1", "L2", "L3"] },
        "tests": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/relative_path" }
        },
        "evidence_fixtures": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/relative_path" }
        },
        "latency_budget_ms": { "type": "integer", "minimum": 1 }
      }
    },
    "limits": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "startup_timeout_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3000
        },
        "tool_timeout_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30000
        },
        "max_model_output_bytes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65536
        },
        "max_evidence_bytes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5242880
        },
        "max_memory_mb": {
          "type": "integer",
          "minimum": 1,
          "maximum": 512
        }
      }
    },
    "resource_profile": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "latency_class",
        "expected_p95_latency_ms",
        "cpu_class",
        "memory_class",
        "io_profile"
      ],
      "properties": {
        "latency_class": {
          "type": "string",
          "enum": ["interactive", "standard", "batch", "long_running"]
        },
        "expected_p95_latency_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30000
        },
        "cpu_class": {
          "type": "string",
          "enum": ["low", "medium", "high"]
        },
        "memory_class": {
          "type": "string",
          "enum": ["low", "medium", "high"]
        },
        "io_profile": {
          "type": "string",
          "enum": ["none", "filesystem_read", "filesystem_write", "network", "mixed"]
        }
      }
    },
    "commerce": {
      "type": "object",
      "additionalProperties": false,
      "required": ["pricing_model", "metering"],
      "properties": {
        "pricing_model": {
          "type": "string",
          "enum": ["free", "private_beta", "paid_manual", "paid_per_invocation", "subscription", "usage_metered", "enterprise_license"]
        },
        "metering": { "type": "string", "enum": ["none", "per_invocation", "duration", "usage_units"] }
      }
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["build_type", "source_digest", "package_digest", "signature"],
      "properties": {
        "build_type": { "type": "string", "enum": ["developer_upload", "clawhunt_delivery", "first_party"] },
        "source_digest": { "type": ["string", "null"], "pattern": "^sha256:[a-f0-9]{64}$" },
        "package_digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "signature": { "type": "string", "pattern": "^ed25519:.+" }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "required": ["acceptance"],
        "properties": {
          "acceptance": {
            "required": ["latency_budget_ms"],
            "properties": {
              "latency_budget_ms": { "exclusiveMinimum": 10000 }
            }
          }
        }
      },
      "then": { "required": ["resource_profile"] }
    },
    {
      "if": {
        "required": ["limits"],
        "properties": {
          "limits": {
            "required": ["tool_timeout_ms"],
            "properties": {
              "tool_timeout_ms": { "exclusiveMinimum": 10000 }
            }
          }
        }
      },
      "then": { "required": ["resource_profile"] }
    },
    {
      "if": {
        "required": ["limits"],
        "properties": {
          "limits": {
            "required": ["max_model_output_bytes"],
            "properties": {
              "max_model_output_bytes": { "exclusiveMinimum": 32768 }
            }
          }
        }
      },
      "then": { "required": ["resource_profile"] }
    },
    {
      "if": {
        "required": ["limits"],
        "properties": {
          "limits": {
            "required": ["max_evidence_bytes"],
            "properties": {
              "max_evidence_bytes": { "exclusiveMinimum": 1048576 }
            }
          }
        }
      },
      "then": { "required": ["resource_profile"] }
    },
    {
      "if": {
        "required": ["limits"],
        "properties": {
          "limits": {
            "required": ["max_memory_mb"],
            "properties": {
              "max_memory_mb": { "exclusiveMinimum": 256 }
            }
          }
        }
      },
      "then": { "required": ["resource_profile"] }
    }
  ],
  "$defs": {
    "semver": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$"
    },
    "relative_path": {
      "type": "string",
      "pattern": "^(?!/)(?!.*\\.\\.).+"
    },
    "json_schema": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {}
      },
      "additionalProperties": true
    },
    "tool": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "input_schema", "output_schema"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "description": { "type": "string", "minLength": 1 },
        "input_schema": { "$ref": "#/$defs/json_schema" },
        "output_schema": { "$ref": "#/$defs/json_schema" }
      }
    },
    "secret_descriptor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "required", "inject_as", "env_name"],
      "properties": {
        "name": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "description": { "type": "string", "minLength": 1 },
        "required": { "type": "boolean" },
        "inject_as": { "type": "string", "enum": ["env"] },
        "env_name": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "ui": { "$ref": "#/$defs/secret_ui" }
      }
    },
    "setting_descriptor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "type", "description", "required"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "type": { "type": "string", "enum": ["string", "integer", "number", "boolean"] },
        "description": { "type": "string", "minLength": 1 },
        "required": { "type": "boolean" },
        "default": {},
        "env_name": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "validation": { "$ref": "#/$defs/setting_validation" },
        "ui": { "$ref": "#/$defs/setting_ui" },
        "options_source": { "$ref": "#/$defs/config_invocation" },
        "actions": {
          "type": "array",
          "items": { "$ref": "#/$defs/config_invocation" }
        }
      }
    },
    "config_invocation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["tool"],
      "properties": {
        "tool": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_.-]*$" },
        "id": { "type": "string", "minLength": 1 },
        "label": { "type": "string", "minLength": 1 },
        "arguments": { "type": "object" }
      }
    },
    "setting_validation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enum": {
          "type": "array",
          "minItems": 1,
          "items": { "type": ["string", "integer", "number", "boolean"] }
        },
        "minimum": { "type": "number" },
        "maximum": { "type": "number" },
        "step": { "type": "number", "exclusiveMinimum": 0 },
        "minLength": { "type": "integer", "minimum": 0 },
        "maxLength": { "type": "integer", "minimum": 0 },
        "pattern": { "type": "string", "minLength": 1 },
        "format": { "type": "string", "enum": ["uri"] }
      }
    },
    "setting_ui": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "control": { "type": "string", "enum": ["text", "textarea", "url", "number", "switch", "select"] },
        "label": { "type": "string", "minLength": 1 },
        "placeholder": { "type": "string" },
        "help": { "type": "string" },
        "advanced": { "type": "boolean" },
        "section": { "type": "string", "enum": ["basic", "advanced"] },
        "step": { "type": "integer", "minimum": 1 },
        "step_title": { "type": "string" },
        "step_description": { "type": "string" }
      }
    },
    "secret_ui": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "label": { "type": "string", "minLength": 1 },
        "help": { "type": "string" },
        "advanced": { "type": "boolean" },
        "section": { "type": "string", "enum": ["basic", "advanced"] },
        "step": { "type": "integer", "minimum": 1 },
        "step_title": { "type": "string" },
        "step_description": { "type": "string" }
      }
    }
  }
} as const;
