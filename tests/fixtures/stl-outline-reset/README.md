# Outline-reset regression fixtures

`messages.json` preserves the role, block, tool-name and parent/child shape of the affected transcript: an assistant tool call, its result, intermediate assistant prose, a user boundary, and the pure-text assistant artifact owner. Text, identifiers, tool arguments, model metadata and timestamps are sanitized/deterministic; no production credentials or private paths are retained.

`hook-cover.stl` is the actual small 108-triangle test model linked in that transcript, not a generic cube. The integration test copies it into its own workspace, seeds a real saved session, authenticates through bootstrap/password setup, and invokes the installed extension and outline derivation without network routes or mock mode.

The original bug survives iframe-element identity checks: activity regrouping moves the owner, reloads the iframe document, and resets the runtime. The test checks document nonce, load count, camera uniforms, checkbox, original-source request count and naturally occurring message refreshes, including density transitions.
