# CAD construction and inspection

Use the installed CLI/tool help and runtime API documentation for actual commands. This reference supplies durable reasoning, not application-specific signatures.

## State and entity contracts

Before editing, identify the active document/component, owning component, occurrence transforms, and selection/entity context. Native geometry and an assembly proxy are not interchangeable inputs. Activating a component is not a substitute for an operation's explicit destination-occurrence/transform contract; keep all feature inputs in a consistent supported context. Resolve persistent references through the runtime; do not assume object handles remain valid after Boolean edits, timeline rollback, or reopening. Reidentify changed edges by geometric support, interval overlap and adjacent semantic surfaces, requiring an unambiguous match. Fillets can trim or slightly extend endpoints; strict old-vertex containment can reject the correct edge. Distinguish consumed edges from missing/ambiguous ones instead of substituting a nearby curve or forcing an old count.

Distinguish an open trim boundary from a periodic surface seam. Adjacent-face count alone can misclassify a seam: in a BRep, one face can use the same edge twice through separate coedges. Inspect coedge/loop incidence and verify the candidate boundary is closed before building a Path or closure. Use the runtime's topology semantics rather than blindly applying mesh adjacency rules.

Separate three gates:

1. The input is an admissible entity type in the correct context.
2. The runtime successfully constructs a healthy feature.
3. The resulting geometry meets the intended constraint.

None implies the next. A surface labelled tangent in an input definition is not proof of measured continuity; a successful join is not proof of intact geometry. Preserve enough diagnostics to reproduce a failure without retrying destructive operations on the accepted model.

## Incremental feature loop

Inspect and save an explicit checkpoint before risky edits. Make one local change at a time and inspect the result in the native model plus useful views/sections. Verify supported API properties and read back effective state after setting cameras, transforms or modes: some Python bindings permit arbitrary attributes without affecting the application. A view label is not evidence of its actual projection type. A property readback also does not prove unit interpretation: if installed behavior contradicts documentation, test one known-size primitive and measure the resulting geometry before applying the setting to the full design. Record runtime/version-specific findings separately from general modeling principles. Undo only the known operation; do not assume a long script is a single undo transaction. If rollback is uncertain, use a separate candidate document or copied body. Mark rejected candidates clearly.

Some hosts retain interpreter globals and imported helper modules between calls. A fresh entry point or current on-disk source hash does not prove the loaded helpers are current. At a verified safe boundary, use an explicit versioned namespace or reload only owned helpers and their consumers, accounting for cached function bindings and existing class instances. Verify loaded code/version and freeze it during a candidate build; do not indiscriminately reload the host SDK/native bindings.

Do not catch and suppress errors at the execution entry point. Where a diagnostic catches a failure to record context, report the failed stage explicitly and re-raise or return an unmistakable failed result. Files exported before an exception are not evidence of successful completion.

## Planar designs and smooth regions

Choose features for design intent, not merely because an operation is available. Do not blanket-fillet every edge: near-tangent or nearly coplanar joins can create extremely narrow sliver faces with little visible benefit and fragile downstream tessellation. Select finishing by edge function, dihedral angle and local feature scale, preserving deliberate creases. Group coherent features and share driving references; a smaller tree is not better if it hides design intent in opaque imports.

A noisy reconstructed panel need not be an intended curved face. Fit likely planar interiors, review their adjacency, and solve shared edges/vertices with appropriate constraints. Report residuals to raw observations and total source displacement, including earlier registration/semantic changes. Do not manufacture unsupported diagonals just to triangulate nonplanar landmark sets.

For curved lofts, inspect section centroids, widths, local tangents and profile frames. Coincident spline endpoints are not proof of smooth periodic closure: verify the runtime's closed/periodic state and tangents where a closed section is intended. Repeating the first fit point can leave a discontinuous seam that propagates through a loft. Use consistent orientation along the centreline and compare corresponding stations. Visible-side boundaries are not full-section centres. Single-view silhouette matching can produce an anamorphic shape that fails other views. Preserve independent depth priors and label symmetry as an assumption when not measured.

Check measurement consistency: the distance between returned witness points must agree with a reported distance within justified numerical uncertainty. If it does not, classify that API result as invalid rather than accepting or rejecting geometry from its scalar. A verified point evaluated inside the target surface's actual domain and trimmed face supplies a distance upper bound, not proof of the exact nearest distance. Report sampling coverage separately from global equivalence.

At a seam, distinguish position continuity, tangent continuity, and curvature continuity. Inspect the actual boundary and adjacent face normals/curvatures using runtime evaluators where possible. A rounded endpoint option or tiny fillet does not prove the visible perimeter is rounded. Rendering bands may be tessellation, but a large outline discontinuity is a geometry issue until demonstrated otherwise.

## Boolean and assembly verification

Check operand and result validity, shell/lump counts, bounds and volume. For a union of valid solids A and B, require the result volume to lie between max(VA, VB) and VA + VB within justified numerical tolerance. Where available, independently check the intersection identity Vunion = VA + VB - Vintersection. These are necessary consistency checks, not exhaustive validity proofs. Record the actual property calculation accuracy returned by the runtime; do not assign a precision level to an unqualified volume accessor. A subtraction involving large operands inherits uncertainty from all terms, not just the small added feature. An uncertainty budget may explain a residual without proving that a small feature survived.

For set-difference validation, require successful Boolean execution before interpreting an empty result. A failed operation, invalid target or exception is not evidence that nothing remains. Where feasible check both operand coverage and absence of excess material; classify unresolved coincident/sliver failures as unknown rather than passing them. Corroborate with independently inspected sections and exported topology.

Positive contact volume proves overlap, not appropriate anatomy, sufficient joint thickness, or strength. Inspect sections and orthographic views around roots and attachments. A visually overlapping projection may still describe disconnected solids. Individually valid assembly bodies do not establish a fused manufacturing master.
