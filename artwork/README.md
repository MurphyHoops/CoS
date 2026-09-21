# App icon artwork


> **CoS 3.x subsystem reference.** This document covers one component, experiment or design lineage. Interpret it under docs/architecture.md and AGENTS.md; where older terminology conflicts with the durable-mission model, the 3.x canonical documents win.

The production icon is generated from `app-icon-source.png` by
`scripts/make-icon.mjs`. Run `npm run icon` to regenerate the Windows ICO, its preview,
and the four Chrome extension PNGs.

## 2026-08-21 redesign

The app redesign is intentionally monochrome: near-black `#0c0c0e`, warm white
`#f4f4f6`, rounded geometry, and no decorative brand colour. Five separate concepts were
generated with the built-in ImageGen tool as transparent, text-free, square logo marks:

1. a friendly folder/speech-bubble character with two dot eyes;
2. file and chat panels meeting through a small bridge and spark;
3. a soft-brutalist file-drawer companion with a speech-bubble handle;
4. a speech bubble containing a welcoming doorway into a local folder;
5. one continuous ribbon folding into a folder pocket and conversation tail.

Every prompt required a bold 16 px silhouette, the same black/white palette, generous
padding, no lettering, no ChatGPT/OpenAI mark, no thin strokes, no colour, and no enclosing
app-store mockup. Concept 5 was selected because it is the least generic and still reads when
reduced to toolbar size. In CoS 3.x the folder/conversation shapes are visual shorthand for local
work plus an execution carrier; the durable mission, not a particular chat, is the product identity.

The checked-in PNG is the selected model output, not a hand-assembled composite. The
generator decodes that one source without an image dependency, tight-crops its alpha,
quantizes the slight model shading to the renderer's exact two colours, area-resamples each
required size, and writes the multi-resolution ICO plus extension assets. This keeps the
model-created silhouette while making every shipped binary deterministic and reviewable.
