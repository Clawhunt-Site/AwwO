"""Windows-only test skip set — the honest deselection for the `windows-latest` CI job.

These tests assert POSIX-only semantics with NO Windows equivalent: owner mode bits
(chmod 0o600/0o700, exec/setuid in a content digest), symlink / FIFO / hardlink
rejection (Windows symlinks need privilege; FIFOs do not exist), POSIX signals /
process-group escalation (Windows uses taskkill), AF_UNIX local-daemon broker IPC,
fcntl/flock locks, dir_fd/O_NOFOLLOW TOCTOU swap detection, POSIX shell + shebang +
coreutils plugin fixtures, and $HOME-vs-%USERPROFILE% / locale-codec (gbk) /
forward-slash test setups.

The PRODUCT runs on Windows — it branches to NTFS-ACL / taskkill / thread-reader /
realpath-containment equivalents. These are TEST assertions that cannot hold on
Windows, so a green Windows run means "Windows is healthy", not "POSIX assumptions
happened to pass" (tests/conftest.py applies this set via pytest_collection_modifyitems).

Real Windows bugs surfaced during the port were FIXED, not skipped: file_view
realpath-containment read path; credential_guard cross-drive _is_within + backslash
shlex bypass; _exec_tool os.name regex collision; _turn_meter elapsed_ms on coarse
monotonic. See docs/windows-support-assessment.md. As each test below grows a
Windows-equivalent assertion, drop it from this set.
"""
from __future__ import annotations

WINDOWS_POSIX_SKIPS: frozenset[str] = frozenset(
    {
        # test_api.py: AF_UNIX local-daemon broker IPC (no Windows equivalent)
        'tests/test_api.py::test_api_daemon_broker_lifecycle_scrubs_and_cleans_up',
        # test_api_preview.py: HOME vs USERPROFILE ($HOME fixture; Path.home() uses USERPROFILE on Windows)
        'tests/test_api_preview.py::test_corrupt_sign_key_is_regenerated',
        # test_capability_receipt.py: symlink rejection (symlink creation needs privilege on Windows)
        'tests/test_capability_receipt.py::test_stage_rejects_symlink_source',
        'tests/test_capability_receipt.py::test_stage_rejects_symlinked_kind_component',
        'tests/test_capability_receipt.py::test_stage_rejects_symlinked_parent',
        'tests/test_capability_receipt.py::test_stage_rejects_symlinked_root',
        # test_capability_submission.py: POSIX shell smoke-test fixture (sh + coreutils under System32-only PATH)
        'tests/test_capability_submission.py::test_distribution_publish_binds_each_capability_kind_to_digest_version_and_opaque_ref[plugin-_copy_plugin_fixture]',
        'tests/test_capability_submission.py::test_distribution_sign_rejects_mismatched_record_digest_for_plugin_ref',
        # test_capability_workshop_e2e.py: POSIX shell smoke-test fixture in the hello-world plugin
        'tests/test_capability_workshop_e2e.py::test_capability_workshop_local_mock_e2e_upload_publish_download_and_sync',
        # test_claude_stream.py: fixture writes a no-extension chmod+x shebang script (WinError 193 on Popen)
        'tests/test_claude_stream.py::test_claude_backend_streams_when_sink_present',
        # test_clawhunt_auth.py: POSIX 0600/0700 mode-bit assertion (NTFS uses ACLs; see secure_fs)
        'tests/test_clawhunt_auth.py::test_clawhunt_auth_store_persists_with_private_permissions_and_sanitized_summary',
        # test_clawwork_session.py: POSIX 0700 mode-bit assertion on the session dir
        'tests/test_clawwork_session.py::test_native_session_dir_is_home_only_and_0700',
        # test_cli.py: AF_UNIX local-daemon broker IPC
        'tests/test_cli.py::test_cli_daemon_broker_lifecycle_scrubs_and_cleans_up',
        # test_company_export_cli.py: symlink fixture + read_text() locale-codec (gbk) decode of em-dash
        'tests/test_company_export_cli.py::test_cli_export_under_symlinked_parent_succeeds',
        'tests/test_company_export_cli.py::test_cli_export_writes_bundle_and_roundtrips',
        # test_containment.py: symlink + hardlink secret-alias rejection
        'tests/test_containment.py::test_low_trust_read_file_blocks_secret_symlink_and_hardlink',
        # test_credential_guard.py: symlink credential-alias fixtures (symlink creation needs privilege)
        'tests/test_credential_guard.py::test_command_cwd_relative_symlink_raises',
        'tests/test_credential_guard.py::test_relative_path_resolves_against_cwd',
        'tests/test_credential_guard.py::test_symlink_into_credentials_protected',
        # test_daemon.py: AF_UNIX local-daemon broker + Rich box-glyph stdout decoded via gbk locale
        'tests/test_daemon.py::test_broker_materializes_private_governed_plugin_view_and_cleans_up',
        'tests/test_daemon.py::test_local_broker_control_persists_without_secret_leakage_and_cleans_up',
        'tests/test_daemon.py::test_local_broker_ipc_socket_path_safety_and_platform_boundary',
        'tests/test_daemon.py::test_module_entry_sees_every_command',
        # test_desktop_runtime.py: POSIX process-group signal escalation (killpg/SIGKILL); Windows uses taskkill.
        # The three *signature/terminate* tests monkeypatch the GLOBAL os.name to "posix",
        # which on Windows additionally makes pathlib instantiate a PosixPath and crashes
        # the whole pytest session (not just the test) — they MUST be skipped at collection
        # (a skipped test never runs the monkeypatch) or the session aborts.
        'tests/test_desktop_runtime.py::test_terminate_own_process_group_reaps_descendants_then_group',
        'tests/test_desktop_runtime.py::test_process_start_signature_retries_transient_failure',
        'tests/test_desktop_runtime.py::test_process_start_signature_distinguishes_reused_pid',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_escalates_to_process_group',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_escalates_to_sigkill',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_group_eperm_degrades_to_single_pid',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_group_waits_for_stubborn_child',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_never_signals_own_group',
        'tests/test_desktop_runtime.py::test_shutdown_process_pid_single_pid_when_not_group_leader',
        # test_developer_identity.py: POSIX 0600 key-file + wide-permission tightening mode bits
        'tests/test_developer_identity.py::test_ensure_backs_up_divergent_local_key_to_legacy',
        'tests/test_developer_identity.py::test_ensure_escrows_and_caches_server_pair',
        'tests/test_developer_identity.py::test_existing_key_path_self_heals_wide_directory',
        'tests/test_developer_identity.py::test_existing_wide_permission_key_is_tightened',
        'tests/test_developer_identity.py::test_keygen_is_idempotent_and_private_key_is_0600',
        # test_diagnostics_store.py: POSIX 0600/0700 mode bits + SIGKILL-durability + lock-drop timing
        'tests/test_diagnostics_store.py::test_critical_durable_across_sigkill',
        'tests/test_diagnostics_store.py::test_db_file_is_0600',
        'tests/test_diagnostics_store.py::test_diagnostic_drop_on_full_queue_is_counted',
        'tests/test_diagnostics_store.py::test_existing_journal_perms_tightened',
        'tests/test_diagnostics_store.py::test_journal_is_0600',
        'tests/test_diagnostics_store.py::test_parent_directory_is_0700',
        'tests/test_diagnostics_store.py::test_wal_sidecars_are_0600',
        # test_environment_config.py: HOME vs USERPROFILE ($HOME-based legacy-file fixture)
        'tests/test_environment_config.py::test_staging_auth_path_preserves_legacy_file',
        # test_external_mcp_plugin.py: POSIX shell/exec sidecar fixture under System32-only PATH
        'tests/test_external_mcp_plugin.py::test_external_mcp_echo_through_full_proxy',
        'tests/test_external_mcp_plugin.py::test_external_mcp_in_band_tool_error_is_returned_to_model',
        'tests/test_external_mcp_plugin.py::test_external_mcp_timeout_fails_closed',
        # test_file_view.py: symlink/FIFO/hardlink rejection + CRLF-on-write fixture (read path itself fixed for Windows)
        'tests/test_file_view.py::test_checkout_root_replaced_by_symlink_fails_closed',
        'tests/test_file_view.py::test_fifo_is_not_a_regular_file',
        'tests/test_file_view.py::test_managed_dir_tamper_fails_closed',
        'tests/test_file_view.py::test_reads_markdown_with_markdown_mime',
        'tests/test_file_view.py::test_symlink_escaping_root_is_rejected',
        'tests/test_file_view.py::test_symlink_to_internal_sensitive_is_refused',
        'tests/test_file_view.py::test_symlinked_intermediate_dir_is_refused',
        # test_lock_granularity.py: git pack-file rmtree Windows lock + POSIX lock semantics
        'tests/test_lock_granularity.py::test_guard_released_after_run',
        'tests/test_lock_granularity.py::test_unisolatable_per_issue_serializes_with_guard',
        # test_logging_config.py: POSIX 0600 log-file mode bits
        'tests/test_logging_config.py::test_log_file_is_chmod_0600',
        'tests/test_logging_config.py::test_rotation_keeps_files_0600',
        # test_migrate_home.py: symlinked data-root / broken-symlink TOCTOU (symlink creation needs privilege)
        'tests/test_migrate_home.py::test_migrate_does_not_move_symlinked_data_root',
        'tests/test_migrate_home.py::test_migrate_toctou_conflict_midgroup_leaves_foreign_dest_untouched',
        'tests/test_migrate_home.py::test_migrate_treats_broken_symlink_at_dest_as_conflict',
        # test_node_runtime.py: POSIX signal teardown + process-group SIGKILL (Windows uses taskkill).
        # install_signal_teardown() is a deliberate no-op on Windows (node_runtime.py returns early
        # for os.name == 'nt'), so the multi-supervisor variant's SIGTERM handler is never installed.
        'tests/test_node_runtime.py::test_install_signal_teardown_handler_stops_and_reraises',
        'tests/test_node_runtime.py::test_terminate_live_process_escalates_to_sigkill',
        'tests/test_node_runtime.py::test_terminate_live_process_group_signals_and_reaps',
        'tests/test_node_runtime.py::test_install_signal_teardown_multi_supervisor_reverse_order',
        # test_node_runtime.py: build_env DOES provision the receipt key + inject its PATH on Windows
        # (workshop_receipt_key.py is now Windows-aware), but this test also asserts the key file is
        # 0o600 (`& 0o177 == 0`) — unreachable on NTFS, where a writable file always reports 0o666.
        'tests/test_node_runtime.py::test_build_env_injects_workshop_receipt_key_file_path',
        # test_node_runtime.py: asserts a POSIX PATH layout — splits env["PATH"] on ":" and expects a
        # standalone "/opt/homebrew/bin" element; Windows joins PATH with ";" so the split cannot match.
        'tests/test_node_runtime.py::test_build_env_override_path_takes_precedence',
        # test_operator_export.py: POSIX 0600 export-file mode bits
        'tests/test_operator_export.py::test_export_diagnostic_bundle_writes_json_and_envelope',
        'tests/test_operator_export.py::test_export_files_are_0600',
        'tests/test_operator_export.py::test_export_run_condition_writes_json_and_envelope',
        # test_permission_posture.py: forward-slash path label assertion (display-only label)
        'tests/test_permission_posture.py::test_reserved_write_target_detection',
        # test_plugin_cloud_api.py: developer-plugin review runs POSIX shell smoke test under System32-only PATH
        'tests/test_plugin_cloud_api.py::test_api_admin_capability_registry_sync_groups_plugin_skill_and_company',
        'tests/test_plugin_cloud_api.py::test_v1_developer_submission_contract_uploads_artifact_and_returns_sanitized_verification',
        # test_plugin_local_verification.py: exec/setuid bit in content digest (POSIX mode bits)
        'tests/test_plugin_local_verification.py::test_digest_changes_when_executable_bit_is_flipped',
        'tests/test_plugin_local_verification.py::test_digest_covers_setuid_bit',
        'tests/test_plugin_local_verification.py::test_digest_owner_exec_is_stable_against_group_other_noise',
        'tests/test_plugin_local_verification.py::test_exec_bit_flip_breaks_signature_in_full_verification',
        # test_plugin_proxy.py: POSIX shell sidecar fixture (sh + coreutils) under sanitized PATH
        'tests/test_plugin_proxy.py::test_proxy_timeout_records_error_evidence',
        # test_plugin_submission.py: POSIX shell smoke-test + exec-bit entrypoint fixtures (hello-world plugin)
        'tests/test_plugin_submission.py::test_developer_upload_accepts_coherent_paid_pricing_intent',
        'tests/test_plugin_submission.py::test_developer_upload_accepts_matching_secret_descriptor_and_environment_permission',
        'tests/test_plugin_submission.py::test_developer_upload_allows_benign_get_and_ignores_third_party_markers',
        'tests/test_plugin_submission.py::test_developer_upload_allows_nonblocking_dependency_vulnerability_fixture',
        'tests/test_plugin_submission.py::test_developer_upload_caps_l3_at_l2_and_records_manual_requirements',
        'tests/test_plugin_submission.py::test_developer_upload_cli_submit_and_status',
        'tests/test_plugin_submission.py::test_developer_upload_recommends_l2_when_requested_and_automated_gates_pass',
        'tests/test_plugin_submission.py::test_developer_upload_requires_executable_entrypoint',
        'tests/test_plugin_submission.py::test_developer_upload_submit_signs_verified_package_and_status_is_readable',
        'tests/test_plugin_submission.py::test_developer_upload_submit_yields_ready_for_signing_without_signed_artifact',
        'tests/test_plugin_submission.py::test_sign_reviewed_submission_blocks_blob_mutation_after_review',
        'tests/test_plugin_submission.py::test_sign_reviewed_submission_rejects_digest_record_tampering[artifact_blob_digest]',
        'tests/test_plugin_submission.py::test_sign_reviewed_submission_rejects_digest_record_tampering[package_digest]',
        'tests/test_plugin_submission.py::test_sign_reviewed_submission_rejects_record_blob_path_redirect',
        'tests/test_plugin_submission.py::test_submit_alone_never_produces_verified',
        # test_relay_key.py: POSIX 0600/0700 mode bits on relay key + audit file
        'tests/test_relay_key.py::test_audit_file_is_0600',
        'tests/test_relay_key.py::test_audit_write_creates_0700_parent',
        'tests/test_relay_key.py::test_clawwork_availability_accepts_env_or_stored_key',
        'tests/test_relay_key.py::test_clawwork_availability_treats_login_as_provisionable',
        'tests/test_relay_key.py::test_secure_parent_dir_is_0700',
        # test_runtime.py: asserts POSIX node-path layout in the GUI-safe PATH prepend
        'tests/test_runtime.py::test_desktop_toolchain_path_prepends_gui_safe_node_paths',
        # test_secrets_store.py: symlink rejection + permissive-mode check (POSIX mode bits)
        'tests/test_secrets_store.py::test_key_file_rejects_symlink_and_permissive_mode',
        # test_skill_runtime.py: symlink rejection (symlink creation needs privilege)
        'tests/test_skill_runtime.py::test_inspect_symlinked_dir_not_managed',
        'tests/test_skill_runtime.py::test_project_refuses_destination_symlink',
        'tests/test_skill_runtime.py::test_project_refuses_symlinked_target_dir',
        # test_skill_sync.py: preserves POSIX asset mode bits
        'tests/test_skill_sync.py::test_native_sync_preserves_asset_mode',
        # test_team_mcp_proxy.py: POSIX 0600 ticket-file mode + symlink rejection
        'tests/test_team_mcp_proxy.py::test_aclass_team_run_gets_ticket_and_config[ClaudeCliBackend]',
        'tests/test_team_mcp_proxy.py::test_aclass_team_run_gets_ticket_and_config[CodexAppServerBackend]',
        'tests/test_team_mcp_proxy.py::test_aclass_team_run_gets_ticket_and_config[CodexCliBackend]',
        'tests/test_team_mcp_proxy.py::test_operator_direct_run_gets_operator_channel[ClaudeCliBackend]',
        'tests/test_team_mcp_proxy.py::test_operator_direct_run_gets_operator_channel[CodexAppServerBackend]',
        'tests/test_team_mcp_proxy.py::test_operator_direct_run_gets_operator_channel[CodexCliBackend]',
        'tests/test_team_mcp_proxy.py::test_write_ticket_file_is_0600',
        'tests/test_team_mcp_proxy.py::test_write_ticket_file_reasserts_mode_on_existing',
        'tests/test_team_mcp_proxy.py::test_write_ticket_file_refuses_symlink',
        # test_telemetry_upload.py: fcntl/flock concurrent-spooler lock (POSIX file locking)
        'tests/test_telemetry_upload.py::test_concurrent_spooler_is_skipped_by_lock',
        # test_trust.py: exec/setuid bit in content digest + symlink rejection
        'tests/test_trust.py::test_compute_digest_changes_when_owner_exec_bit_flips',
        'tests/test_trust.py::test_compute_digest_covers_setuid_bit',
        'tests/test_trust.py::test_compute_digest_exec_signal_ignores_group_other_noise',
        'tests/test_trust.py::test_symlink_in_package_is_rejected_with_label',
        # test_trust_state.py: symlink assessment (POSIX symlink)
        'tests/test_trust_state.py::test_assess_non_raising_on_symlink',
        # test_visible_project_folder.py: POSIX dir_fd/O_NOFOLLOW + 0700/sticky/group-world-writable swap detection (Windows uses ACL; see workspace_resolver)
        'tests/test_visible_project_folder.py::test_assert_dir_fd_safe_writable_truth_table',
        'tests/test_visible_project_folder.py::test_assert_managed_dir_unchanged_passes_then_fails_closed_on_swap',
        'tests/test_visible_project_folder.py::test_create_managed_project_dir_makes_visible_0700_folder',
        'tests/test_visible_project_folder.py::test_execution_choke_point_fails_closed_on_swapped_project_dir',
        'tests/test_visible_project_folder.py::test_group_writable_root_is_rejected',
        'tests/test_visible_project_folder.py::test_precreated_leaf_under_sticky_parent_is_never_adopted',
        'tests/test_visible_project_folder.py::test_sticky_exemption_does_not_bypass_owner_gate',
        'tests/test_visible_project_folder.py::test_sticky_world_writable_ancestor_is_accepted',
        'tests/test_visible_project_folder.py::test_world_writable_ancestor_is_rejected',
        # test_worker_backends.py: POSIX 0600 device-key + exec-bit bundled-binary runnable check
        'tests/test_worker_backends.py::test_clawwork_frozen_bundle_resolves_binary_and_governance',
        'tests/test_worker_backends.py::test_clawwork_frozen_bundle_wins_over_path_lookup',
        'tests/test_worker_backends.py::test_clawwork_resolve_executable_rejects_unrunnable_bundled_bin',
        'tests/test_worker_backends.py::test_openclaw_gateway_device_key_is_0600',
        # test_workshop_receipt_key.py: the PRODUCT is Windows-aware — workshop_receipt_key.py
        # branches on os.name (O_NOFOLLOW/fchmod are POSIX-only; owner-only comes from the
        # inherited %USERPROFILE% ACL) to provision + read the receipt key, so the happy-path /
        # race / hard-link (nlink) / 64-hex-format / read-back tests RUN and pass on Windows.
        # Only these POSIX-only assertions have no NTFS analog and are skipped:
        #   exact 0600/0700 mode assertions (NTFS reports 0o666/0o777, never 0o600/0o700):
        'tests/test_workshop_receipt_key.py::test_ensure_generates_0600_64hex_then_idempotent',
        'tests/test_workshop_receipt_key.py::test_secrets_dir_is_0700',
        #   chmod-to-widen then expect-rejection (chmod is a near no-op on NTFS, so the
        #   group/other/exec-accessible condition cannot be constructed; the inherited profile ACL
        #   is the owner-only gate):
        'tests/test_workshop_receipt_key.py::test_read_fails_closed_on_group_other_readable',
        'tests/test_workshop_receipt_key.py::test_read_fails_closed_on_owner_exec_bit',
        'tests/test_workshop_receipt_key.py::test_ensure_fails_closed_on_widened_existing_key',
        'tests/test_workshop_receipt_key.py::test_fails_closed_on_widened_secrets_dir',
        #   symlink rejection (symlink creation needs a privilege on Windows; product still
        #   rejects a symlinked key via an explicit islink guard where one is present):
        'tests/test_workshop_receipt_key.py::test_fails_closed_on_symlink_key',
        'tests/test_workshop_receipt_key.py::test_broken_symlink_key_is_anomaly_not_absent',
        # test_workspace_api.py: managed checkout via POSIX dir_fd walk (Windows uses ACL branch)
        'tests/test_workspace_api.py::test_create_company_with_repo_url_clones_managed_checkout',
        # test_workspace_resolver.py: managed checkout identity via POSIX dir_fd/O_NOFOLLOW (Windows uses ACL branch)
        'tests/test_workspace_resolver.py::test_create_trusted_workspace_records_identity',
        'tests/test_workspace_resolver.py::test_materialize_clones_repo_url_into_managed_checkout',
        # --- surfaced by the windows-latest CI run (passed locally, fail on the GH
        #     runner) — both POSIX/Windows-environment, not product defects: ---
        # test_plugin_cloud.py: the timeout-clamp fixture's sidecar is a POSIX sh
        # script (#!/usr/bin/env sh) that can't run under the System32-only sandbox
        # PATH on Windows -> PLUGIN_RUNTIME_ERROR not the asserted PLUGIN_TIMEOUT.
        'tests/test_plugin_cloud.py::test_synced_policy_max_tool_timeout_tightens_sidecar_timeout',
        # test_worker_backends.py: the HTTP OOM guard rejects oversized bodies, but
        # Windows surfaces the server-side close as ConnectionAbortedError [WinError
        # 10053] instead of the POSIX "exceeded" body the test asserts. Guard works;
        # only the error SURFACE differs on Windows sockets.
        'tests/test_worker_backends.py::test_http_backend_oom_guard_rejects_oversized_body',
    }
)
