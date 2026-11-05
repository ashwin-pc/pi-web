# Selecting evidence

These are categories to consider, not a mandatory algorithm or promises made by a tool. A check that was not run is unknown, not passed.

## Reconstruction and editing

Compare recognizable silhouettes and features from multiple views. Inspect occluded regions independently of the source-image view. Check whether background or support surfaces became geometry, and whether intended disconnected parts survived. Describe invented hidden geometry. Keep the raw reconstruction for comparison.

Measure exterior deviation when repair risks losing detail; summarize typical and worst-case changes at the actual output scale. A small average error can conceal a damaged thin feature. Use local probes around important features in addition to global summaries.

## Geometry and fabrication

As relevant, inspect:

- Explicit units, final dimensions, orientation, and applied transforms.
- Connected components, boundary/nonmanifold edges, winding, degenerate faces, and duplicate or coincident surfaces.
- Self-intersections and overlapping solids. Edge-manifoldness does not detect every overlap or invalid cap.
- Cross-sections, internal voids, material thickness, and narrow features at the final fabrication scale.
- Intended openings versus unintended cavities. A positive volume does not prove an interior is filled; a closed mesh may describe a thin hollow shell.
- Flat bases, mounting features, clearances, mating surfaces, stability, and fabrication constraints when required by the use case.

Use independent methods for high-consequence claims. For example, combine mesh topology with section/ray probes and a downstream slice. Repairing every boundary loop independently can produce overlapping caps while preserving an unwanted cavity. Global voxel operations can seal intentional openings or bridge gaps. Neither method is universally appropriate.

A geometrically solid object does not imply 100% printed infill. Slicer infill and wall settings govern the printed interior. Inspect an actual slice with the intended profiles when claiming printing behavior. Separate model paths from supports, purge structures, and travel. Thin features may disappear despite a valid mesh.

## Conversion and material preservation

Check the runtime's script-failure exit contract and verify that expected outputs exist, are nonempty and belong to the current invocation. Some applications exit successfully even after a script traceback unless configured otherwise. Process exit success is not proof a render or export completed.

Reopen exported assets and compare bounds, units, orientation, component counts, and required metadata. Check whether the destination format preserves materials, color, parametric history, assemblies, and instances. Do not imply STL carries material assignments.

Retopology changes triangle identities. Face-index-based paint cannot generally be copied unchanged. Use a supported spatial/material transfer when needed, quantify uncertain mappings, and inspect important boundaries. Preserve placements, support overrides, and manufacturing settings separately from geometry, avoiding double-applied transforms.

## Reporting

For each important claim record the method, output revision, measured result, threshold or rationale, and limitation. Show before/after evidence for repairs. Keep failed candidates out of the final deliverable list and preserve the user's originals.
