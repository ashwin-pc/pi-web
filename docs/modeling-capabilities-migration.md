# Modeling capability migration

## Goal

Keep durable reasoning in a general skill, host-specific facts in trusted configuration, and executable integrations behind a small discoverable contract. Adding an operation should ordinarily mean supplying a script/workflow; adding a runtime should ordinarily mean configuration or an adapter, not another agent-facing tool.

The skill is at `examples/pi-web-skills/3d-modeling/SKILL.md`. It deliberately does not name a required backend, installation directory, model, or fixed operation sequence. It can be used with existing tools before a replacement execution interface is activated.

## Separation of responsibilities

- **Skill:** select representations, investigate capabilities, preserve sources, reason about effects and uncertainty, choose evidence appropriate to intended use.
- **Configuration:** runtime identity, executable location, declared capabilities, dependencies, launch policy, and resource constraints. Configuration is trusted executable authority, not arbitrary model-supplied commands.
- **Tools/adapters:** inspect availability and execute bounded, cancellable work with explicit permissions and artifacts. No model loading or installation during registration/discovery.
- **Workflow scripts:** task-specific composition, geometry operations, conversion, validation, and rendering. These can evolve without expanding the tool schema.
- **Host:** authentication, workspace trust, artifact serving, and previews. Retain STL/G-code viewers independently of execution-tool migration.

Discovery must distinguish configured facts from observations and unknowns. File existence is not dependency readiness; an idle check is not resource reservation; a descriptor's capability labels are not proof an operation was tested. Exposed output-path restrictions are not a sandbox for arbitrary runtime code.

## Source migration

The refactored source registers one `modeling` tool whose `args` are the exact argument vector accepted by the standalone CLI. Both use `cad/core.ts`; adapters remain canonical. The old tool-registration wrappers are removed, not the backend capabilities. See the [extension README](../examples/pi-web-extensions/3d-modeling/README.md) for runnable commands and the migration mapping.

This intentionally changes new tool calls: consumers must replace old narrow tool names with the corresponding CLI command. Saved transcript history is not rewritten. Existing STL/G-code previews and the Slice action remain. The previously prototyped generic `modeling` operation-schema tool is superseded by this argv contract, not installed alongside it.

Before activating on a host:

1. Test without expensive inference using fake executables and temporary configuration. Cover missing/malformed configuration, no-op discovery, execution failure, timeout, cancellation, permissions, and traversal/symlink escapes.
2. Configure the real host separately from portable examples. Do not embed a developer's paths in the skill. Do not replace a live inference runtime or reload a working session mid-job.
3. Verify representative commands on the intended host, distinguishing mocked adapter parity from real backend evidence. Reuse the owned generation runner rather than launching inference through a generic subprocess route.
4. Reload resources explicitly or start a new session, then confirm one advertised tool, the general skill and actual discovery results. A running session is not automatically migrated by changing source code.
5. Inspect any uncertain remote Fusion mutation after a transport timeout before retrying. Transport cancellation is not a CAD rollback or proof the remote script stopped.

## Acceptance evidence

- A host with no modeling runtimes configured still returns useful discovery rather than hiding the interface.
- A new configured runtime or novel script can be used without changing the agent-facing schema or the skill.
- Source artifacts remain unchanged and exported files can be reopened.
- Local owned-process failure/cancellation performs documented cleanup without terminating unrelated services. Remote Fusion transport failure reports uncertain mutation state rather than claiming cancellation or rollback.
- Runtime execution is clearly described as unsandboxed, and any filesystem validation claims are scoped accurately.
- Before/after operational evidence and test output are available for review. Production inference is not required for unit tests, but fake tests alone are not backend parity evidence.

## Installation status

Source migration and host activation are separate. Keep actual implementation, test results and installed-host status in change/review evidence; this document does not establish activation. No global paths, settings, active documents or running sessions should be modified implicitly by tests. Never mark a capability available solely because it appears in configuration.
