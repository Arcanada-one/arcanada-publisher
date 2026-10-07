// Ink Press aesthetic palette (paper / ink / amber), derived from the vendored
// video-shotcraft "Ink Press" template's validated look. Kept as typed constants
// so the composition reads its colours from one place and deferred formats /
// themes stay a data change (D5).

export const INK_PRESS = {
  paper: "#F4EFE3", // warm cream paper
  paperDeep: "#E7DFCB", // page shadow / vignette
  ink: "#1E1B16", // near-black ink
  inkSoft: "#4A443A", // secondary ink (kicker / captions)
  amber: "#C8892B", // accent (letterpress glint, underline)
  amberBright: "#E7A63A",
} as const;
