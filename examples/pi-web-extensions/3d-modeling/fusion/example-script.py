"""Inspection-only Fusion MCP example; copy into .pi/web/artifacts/ to submit.

Fusion calls run(context) after loading this file. Define it afresh on every
call, keep operations inside it, and let exceptions propagate to the caller.
"""
import adsk.core


def run(context):
    app = adsk.core.Application.get()
    print(app.version)
