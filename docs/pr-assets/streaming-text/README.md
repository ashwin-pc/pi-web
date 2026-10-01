# Streamed assistant text: before / after

![Before / after](before-after.gif)

[MP4 recording](before-after.mp4)

## Scenario

Send `streaming reveal fixture` to the isolated mock app. It streams four chunks 420ms apart:

1. `Hello `
2. `**bold`
3. `** world`
4. `\n\nFinal tail.`

Both versions finish with the same formatted response: `Hello **bold** world`, followed by `Final tail.` The incomplete bold delimiter exercises Markdown reconciliation, rather than only plain-text append.

- **Before:** renderer and styles from `637b6e0`, with the same mock response backported. Text appears immediately and the changing paragraph is replaced between batches.
- **After:** this branch. New text fades over 350ms ease-out; existing text nodes, live spans and their animations remain mounted during ordinary growth. Historical messages and reduced-motion streams remain immediate.
- **Unchanged:** 75ms stream batching; no artificial word-by-word pacing delay.

The recordings use the actual production app, Chromium at 1100 × 780, and isolated mock servers. The comparison crops and enlarges the assistant response, labels both versions, and trims initial recording setup. It contains no private messages, credentials, or external model output.

Additional deterministic tests cover in-progress Element/Text/span/Animation identity, reference definitions inserting siblings, duplicate paragraph text, selection preservation, reduced-motion changes, Markdown sanitization and stream finalization.
