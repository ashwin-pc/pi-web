# Captured Pi abort regression

`after-stop-messages.json` and `owned-pi-session.jsonl` are byte-identical copies of the already-redacted actual Pi canary evidence from issue #92 (`issue92-pi-canary/continuation/`). The aborted SDK message has both partial text and `errorMessage: "OpenAI Responses stream ended before a terminal response event"`.

These files are data only. Tests replay the captured messages; they do not execute the prompt, read its file, call a model, or use credentials. The actual canary observed Read → stream → guarded Stop and retention in the API/JSONL, but UI settlement/reload hid the partial answer. Its cold service restart was **not reached**. Any SDK cold-open test here is **captured-data replay**, not completion of that original canary.

The captured thinking blocks are empty and remain unchanged. Tests for visible thinking and interrupted tool parts use separate, explicitly synthetic inputs.

SHA-256:
- `after-stop-messages.json`: ec178e6059692645e1be8281325b5d31d5436c589c27cbb6df15de33c3f038f3
- `owned-pi-session.jsonl`: 347c8806d87d6c506280a64f38abdc3b3fc3d55d33bc5ef7604dc6986e439478
