# Captured Pi abort regression

`after-stop-messages.json` and `owned-pi-session.jsonl` are public, additionally redacted copies of the actual Pi canary evidence from issue #92 (evidence retained by the author; summarized in the PR). The aborted SDK message has both partial text and `errorMessage: "OpenAI Responses stream ended before a terminal response event"`.

These files are data only. Tests replay the captured messages; they do not execute the prompt, read its file, call a model, or use credentials. The actual canary observed Read → stream → guarded Stop and retention in the API/JSONL, but UI settlement/reload hid the partial answer. Its cold service restart was **not reached**. Any SDK cold-open test here is **captured-data replay**, not completion of that original canary.

The captured thinking text remains empty. Provider identifiers and opaque signatures are redacted; message identities, content, ordering and abort semantics remain captured data, not synthetic replacements. Tests for visible thinking and interrupted tool parts use separate, explicitly synthetic inputs.

SHA-256:
- `after-stop-messages.json`: 34f27fc3cbf06cbb49323cfecc94e51ab7b716d8217e38f86d753b6a0c3cbfcb
- `owned-pi-session.jsonl`: 593d5d1a05ea5faab12008de0046a0e49135ba9c2ced7aec795a7ea9cb23560d
