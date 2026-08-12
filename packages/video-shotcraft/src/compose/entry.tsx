// Remotion bundle entry — registers the composition root. @remotion/bundler
// points at this file (resolved via paths.compositionEntry()).

import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
