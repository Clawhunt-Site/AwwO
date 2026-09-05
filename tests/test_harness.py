import json

from superclaw.harness import (
    adapt_agent,
    adapt_skill,
    emit_harness_artifacts,
    harness_matrix,
    inventory_plugins,
    parse_markdown_with_frontmatter,
    partition_tool_calls,
    rewrite_tool_prose,
    runtime_profile,
    validate_harness_artifacts,
)


def test_harness_matrix_and_runtime_profile_include_agents_and_claude_code():
    matrix = harness_matrix()
    profile = runtime_profile()

    assert matrix["claude-code"]["plugin_marketplace"] is True
    assert matrix["codex"]["commands_native"] is False
    assert matrix["codex"]["skill_body_max_bytes"] == 8192
    assert profile["claude_code_task_types"]["local_agent"]["prefix"] == "a"
    assert "completed" in profile["terminal_task_statuses"]


def test_rewrite_tool_prose_and_partition_readonly_batches():
    body = "Use the Read tool, the `Grep` tool, then the Bash tool."

    assert "open the file" in rewrite_tool_prose(body, "codex")
    assert "run the shell command" in rewrite_tool_prose(body, "codex")
    assert partition_tool_calls(["Read", "Grep", "Bash", "Glob"]) == [
        {"is_concurrency_safe": True, "tools": ["Read", "Grep"]},
        {"is_concurrency_safe": False, "tools": ["Bash"]},
        {"is_concurrency_safe": True, "tools": ["Glob"]},
    ]


def test_adapt_agent_degrades_claude_fields_to_codex_sandbox():
    artifact = adapt_agent(
        plugin="reviews",
        name="explorer",
        target="codex",
        frontmatter={
            "description": "Read-only exploration",
            "model": "opus",
            "tools": ["Read", "Grep"],
            "color": "blue",
        },
        body="Use the Read tool and report findings.",
    )

    assert artifact.name == "reviews__explorer"
    assert artifact.frontmatter["model"] == "gpt-5"
    assert artifact.frontmatter["sandbox_mode"] == "read-only"
    assert "open the file" in artifact.body
    assert any("dropped unsupported agent fields" in warning for warning in artifact.warnings)


def test_adapt_skill_splits_codex_oversized_body():
    artifact = adapt_skill(
        plugin="docs",
        name="large",
        target="codex",
        frontmatter={"description": "Large skill", "model": "sonnet"},
        body="## Section\n" + ("Use the Read tool.\n" * 900),
    )

    assert artifact.frontmatter["name"] == "docs__large"
    assert artifact.overflow
    assert len(artifact.body.encode("utf-8")) <= 7400
    assert any("skill body split" in warning for warning in artifact.warnings)


def test_inventory_plugins_counts_agents_style_tree(tmp_path):
    plugin_dir = tmp_path / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"description": "Demo", "version": "1.2.3"}),
        encoding="utf-8",
    )
    (plugin_dir / "agents").mkdir()
    (plugin_dir / "agents" / "worker.md").write_text("---\nname: worker\ndescription: work\n---\nBody", encoding="utf-8")
    (plugin_dir / "skills" / "ship").mkdir(parents=True)
    (plugin_dir / "skills" / "ship" / "SKILL.md").write_text("---\nname: ship\ndescription: ship\n---\nBody", encoding="utf-8")
    (plugin_dir / "commands").mkdir()
    (plugin_dir / "commands" / "run.md").write_text("---\ndescription: run\n---\nBody", encoding="utf-8")

    inventory = inventory_plugins(tmp_path)

    assert inventory.plugin_count == 1
    assert inventory.agent_count == 1
    assert inventory.skill_count == 1
    assert inventory.command_count == 1
    assert inventory.plugin_details[0]["version"] == "1.2.3"


def test_emit_harness_artifacts_writes_cursor_opencode_gemini_targets(tmp_path):
    source_root = tmp_path / "source"
    plugin_dir = source_root / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"description": "Demo plugin", "version": "1.2.3"}),
        encoding="utf-8",
    )
    (plugin_dir / "agents").mkdir()
    (plugin_dir / "agents" / "worker.md").write_text(
        "---\nname: worker\ndescription: Work\ntools: [Read, Grep]\nmodel: opus\n---\nUse the Read tool.\n",
        encoding="utf-8",
    )
    (plugin_dir / "skills" / "ship").mkdir(parents=True)
    (plugin_dir / "skills" / "ship" / "SKILL.md").write_text(
        "---\nname: ship\ndescription: Ship\n---\nUse the Bash tool.\n",
        encoding="utf-8",
    )
    (plugin_dir / "commands").mkdir()
    (plugin_dir / "commands" / "run.md").write_text(
        "---\ndescription: Run it\nargument-hint: GOAL\n---\nRun the Task tool.\n",
        encoding="utf-8",
    )

    cursor = emit_harness_artifacts(source_root, tmp_path / "cursor-out", target="cursor")
    opencode = emit_harness_artifacts(source_root, tmp_path / "opencode-out", target="opencode")
    gemini = emit_harness_artifacts(source_root, tmp_path / "gemini-out", target="gemini")

    assert ".cursor-plugin/marketplace.json" in [path.replace("\\", "/") for path in cursor.written]
    assert (tmp_path / "cursor-out" / ".claude" / "agents" / "demo__worker.md").exists()
    assert (tmp_path / "opencode-out" / ".opencode" / "agents" / "demo-worker.md").exists()
    assert (tmp_path / "opencode-out" / "opencode.json").exists()
    assert (tmp_path / "gemini-out" / "agents" / "demo__worker.md").exists()
    assert (tmp_path / "gemini-out" / "commands" / "demo" / "run.toml").exists()
    assert "run_shell_command" in (tmp_path / "gemini-out" / "skills" / "demo__ship" / "SKILL.md").read_text(encoding="utf-8")
    assert opencode.plugins == ["demo"]
    assert gemini.plugins == ["demo"]


def test_emit_harness_artifacts_filters_plugins_and_refuses_bad_root(tmp_path):
    source_root = tmp_path / "source" / "plugins"
    (source_root / "one" / ".claude-plugin").mkdir(parents=True)
    (source_root / "one" / ".claude-plugin" / "plugin.json").write_text("{}", encoding="utf-8")
    (source_root / "two" / ".claude-plugin").mkdir(parents=True)
    (source_root / "two" / ".claude-plugin" / "plugin.json").write_text("{}", encoding="utf-8")

    report = emit_harness_artifacts(source_root, tmp_path / "out", target="codex", plugins=["one"])
    missing = emit_harness_artifacts(tmp_path / "missing", tmp_path / "out", target="codex")

    assert report.plugins == ["one"]
    assert "AGENTS.md" in report.written
    assert missing.warnings == [f"plugin root not found: {(tmp_path / 'missing').resolve()}"]


def test_validate_harness_artifacts_accepts_generated_targets(tmp_path):
    source_root = tmp_path / "source"
    plugin_dir = source_root / "plugins" / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"description": "Demo plugin", "version": "1.2.3"}),
        encoding="utf-8",
    )
    (plugin_dir / "agents").mkdir()
    (plugin_dir / "agents" / "worker.md").write_text(
        "---\nname: worker\ndescription: Work\ntools: [Read]\nmodel: sonnet\n---\nUse the Read tool.\n",
        encoding="utf-8",
    )
    (plugin_dir / "skills" / "ship").mkdir(parents=True)
    (plugin_dir / "skills" / "ship" / "SKILL.md").write_text(
        "---\nname: ship\ndescription: Ship\n---\nUse the Bash tool.\n",
        encoding="utf-8",
    )
    (plugin_dir / "commands").mkdir()
    (plugin_dir / "commands" / "run.md").write_text("---\ndescription: Run it\n---\nRun.\n", encoding="utf-8")

    for target in ["codex", "cursor", "opencode", "gemini"]:
        output_root = tmp_path / f"{target}-out"
        emit_harness_artifacts(source_root, output_root, target=target)
        report = validate_harness_artifacts(output_root, target=target)
        assert report.ok, report.to_dict()
        assert report.checked_files


def test_validate_harness_artifacts_reports_codex_shape_errors(tmp_path):
    skill_dir = tmp_path / ".codex" / "skills" / "bad"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: other\ndescription: Bad\n---\n" + ("x" * 9000),
        encoding="utf-8",
    )
    (tmp_path / ".codex" / "agents").mkdir()
    (tmp_path / ".codex" / "agents" / "bad.toml").write_text('name = "bad"\nsandbox_mode = "wide-open"\n', encoding="utf-8")

    report = validate_harness_artifacts(tmp_path, target="codex")

    assert not report.ok
    messages = [finding.message for finding in report.findings]
    assert any("frontmatter name" in message for message in messages)
    assert any("8192" in message for message in messages)
    assert any("missing required TOML fields" in message for message in messages)
    assert any("invalid sandbox_mode" in message for message in messages)


def test_parse_markdown_frontmatter_supports_inline_and_block_lists():
    frontmatter, body = parse_markdown_with_frontmatter(
        "---\nname: worker\ntools: [Read, Grep]\nskills:\n  - review\n---\n# Body\n"
    )

    assert frontmatter["name"] == "worker"
    assert frontmatter["tools"] == ["Read", "Grep"]
    assert frontmatter["skills"] == ["review"]
    assert body.startswith("# Body")
