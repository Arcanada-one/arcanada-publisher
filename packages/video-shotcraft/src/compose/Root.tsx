// Remotion root: registers the CinematicPromo composition. Dimensions, fps and
// duration are resolved from inputProps (echoed from the RenderFormat) via
// calculateMetadata, so a single composition serves every registered format.

import { Composition } from "remotion";
import { CinematicPromo, defaultCinematicProps, type CinematicPromoProps } from "./CinematicPromo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CinematicPromo"
      component={CinematicPromo}
      durationInFrames={defaultCinematicProps.durationInFrames}
      fps={defaultCinematicProps.fps}
      width={defaultCinematicProps.width}
      height={defaultCinematicProps.height}
      defaultProps={defaultCinematicProps}
      calculateMetadata={({ props }: { props: CinematicPromoProps }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
};
