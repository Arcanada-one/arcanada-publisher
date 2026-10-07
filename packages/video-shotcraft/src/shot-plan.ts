// Shot-plan primitives shared between the Node-side render entry and the
// webpack-bundled Remotion composition. Kept dependency-free (no react/remotion)
// so it is safe to import from either side.

export interface ShotSpec {
  name: string;
  durationFrames: number;
}

/** Total composition length in frames for a given shot/asset plan. */
export function totalFrames(props: { shots: ShotSpec[]; assetCount: number }): number {
  const titleFrames = props.shots[0]?.durationFrames ?? 83;
  return titleFrames + props.assetCount * 90 + 60;
}
