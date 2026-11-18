---
name: 3d-modeling
description: Create, generate, edit, inspect, render, convert, or prepare 3D assets and CAD for fabrication. Use for image-to-3D, meshes, procedural geometry, Blender, CAD, printing, slicing, and diagnosing model defects. Discover current capabilities instead of assuming a particular backend or workflow.
---

# 3D modeling

## Start with intent and discovery

Identify the intended result: visualization, editable design, measurement, simulation, fabrication, or another use. Choose representations and checks for that purpose; do not force every request through mesh generation or print preparation. Ask only for missing decisions that materially affect the result. Label provisional assumptions, especially dimensions and inferred surfaces.

Discover current tools and runtime configuration before choosing an implementation. Prefer the installed capability-discovery interface when available; otherwise inspect documented configuration and existing runtimes using ordinary file/shell tools. Discovery should not start inference, import heavy models, download dependencies, mutate documents, or interrupt services.

Distinguish missing configuration from missing installation, unavailable dependencies, a busy resource, unsupported operation, and an untested capability. An absent tool or environment variable is not proof the underlying capability does not exist. If blocked, report the exact failed check and investigate documented alternatives before asking the user to install anything. Prior session artifacts can supply evidence, but promote reusable knowledge into maintained configuration or scripts rather than depending on history forever.

## Compose a workflow

Use the least lossy representation suited to the goal. Parametric solids, triangle meshes, point clouds, implicit volumes, materials, scenes, and manufacturing projects preserve different information. Conversion is not necessarily reversible. Keep units, coordinate conventions, transforms, and material assignments explicit.

Use the available runtime's scripting or workflow interface for novel tasks; do not require a new agent tool for each operation. Read its current contract and relevant runtime documentation. Runtime paths, backend names, model choices, launch arguments, and machine resource policy belong in configuration or adapter documentation, not this skill.

Respect a requested representation and operation order. If the goal is CAD, a polished mesh or thousands of triangle-wrapped BRep faces are not equivalent to a deliberate editable design. Use reconstructed geometry as a measured reference when appropriate, not as unquestionable ground truth. A single view cannot establish hidden surfaces, physical dimensions, or mechanical accuracy. Preserve this uncertainty even if the output looks plausible.

Work incrementally: inspect the current state, make one bounded change, inspect actual resulting geometry, and tune or undo. Use short scripts when scripting is the runtime interface; do not equate script execution with rebuilding the whole model. Learn required entry-point and entity-context contracts before mutation. Distinguish native entities from occurrence proxies and verify which forms an operation accepts. A descriptive object type alone does not establish admissibility.

For reverse engineering, separate registration from geometry changes. Persist correspondences, coordinate frames, candidate surface topology and fit assumptions. Freeze a provisional camera while evaluating a geometry revision, and compare multiple views so a single-image fit cannot hide distorted depth. Fitted landmarks are training evidence, not independent validation; reserve additional silhouette/crease observations for review. Preserve shared planes and intentional creases instead of exactly matching every noisy sample.

Use independent visual criticism when fidelity matters. Freeze accepted regions and scope revisions to specific defects. A failed technique calls for a bounded diagnostic reproduction or a different construction method, not an unsupported claim that the application lacks the capability. Do not silently abandon the task after self-imposed trial limits; report the blocker and identify the next technical step. Ask the user only when a real preference, consequential tradeoff, or missing authority needs their decision.

Before execution, inspect scripts/workflows and assess effects: unsandboxed code, existing-document mutations, network calls, resource use, file writes, and subprocess ownership. Obtain any required acknowledgement. Never assume artifact-path validation sandboxes executed code. Do not stop unrelated processes or download models without authorization. Coordinate expensive workloads through available resource ownership mechanisms; a point-in-time idle check alone is not a lock.

## Preserve evidence

Keep source inputs and raw generated assets unchanged. Write revisions under new names; record the script/workflow, parameters, runtime identity, seed when relevant, units, transforms, logs, and outputs needed to reproduce the work. Do not expose credentials in these records.

For user-visible outputs, use the host's artifact directory and supported links/previews. Save an editable native representation when useful as well as the requested interchange format. Validate the actual exported file, not only the in-memory scene. Failed or partial outputs must be clearly distinguished from deliverables.

## Verify against intended use

Separate visual inspection, structural measurements, and downstream behavior. State which checks ran and which remain unavailable. Successful execution, a plausible render, or a watertight mesh alone does not establish suitability.

Read [verification.md](references/verification.md) when choosing validation for fabrication, conversion, reconstruction, or defect repair. Read [cad-inspection.md](references/cad-inspection.md) when editing CAD topology, diagnosing failed features, or verifying smooth surfaces. Select relevant checks rather than applying a fixed pipeline. Do not silently smooth, thicken, fill, decimate, or merge features that may be intentional. If repair materially changes appearance, topology, editability, tolerances, or material boundaries, explain the tradeoff before proceeding.

Deliver the result with a preview where useful, downloadable assets, dimensions/units, concise check results, and remaining uncertainty. Use measured claims such as 'passed these checks'; avoid unqualified 'print-ready' or 'accurate' when the evidence is narrower.
