// The cinematic promo composition (DESIGN §5 §6). A self-authored Remotion
// composition parameterised by the vendored Ink Press aesthetic + the selected
// shot-card timing — it is the deterministic "render" seam; the vendored skill
// provides the authoring assets/params it renders over. Dimensions, fps and
// total duration all arrive via inputProps (echoed from the RenderFormat), so
// deferred vertical/square formats are a data change, not a rewrite.

import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { INK_PRESS } from "./palette";
import type { ShotSpec } from "../shot-plan";

// A `type` alias (not an interface) so it satisfies Remotion's
// `Props extends Record<string, unknown>` constraint on <Composition>.
export type CinematicPromoProps = {
  /** Post text — first line becomes the title, the remainder the kicker. */
  postText: string;
  /** Product screenshots as data URIs (validated + encoded by the render entry). */
  assetDataUris: string[];
  /** Selected shot cards (name + recommended frames), drives shot pacing. */
  shots: ShotSpec[];
  /** Optional soundtrack served from the render publicDir (staticFile path). */
  audioSrc: string | null;
  /** Echoed RenderFormat metadata (used by Root's calculateMetadata). */
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};

export const defaultCinematicProps: CinematicPromoProps = {
  postText: "Arcanada\nOne human life matters",
  assetDataUris: [],
  shots: [{ name: "brand-ink-open", durationFrames: 83 }],
  audioSrc: null,
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
};

function titleAndKicker(postText: string): { title: string; kicker: string } {
  const lines = postText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const title = (lines[0] ?? "Arcanada").slice(0, 60);
  const kicker = lines.slice(1).join(" ").slice(0, 120);
  return { title, kicker };
}

/** Paper backdrop with a soft page vignette — the constant Ink Press stage. */
const PaperStage: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(circle at 50% 42%, ${INK_PRESS.paper} 0%, ${INK_PRESS.paperDeep} 100%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Shot 1 — brand-ink-open: letterpress title press-in + amber glint + hold. */
const TitleShot: React.FC<{ title: string; kicker: string }> = ({ title, kicker }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const press = spring({ frame, fps, config: { damping: 200, mass: 0.8 } });
  const scale = interpolate(press, [0, 1], [1.5, 1]);
  const blur = interpolate(press, [0, 1], [6, 0]);
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const glint = interpolate(frame % 90, [20, 30, 40], [0, 1, 0], { extrapolateRight: "clamp" });
  const kickerChars = Math.floor(
    interpolate(frame, [22, 60], [0, kicker.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  return (
    <PaperStage>
      <AbsoluteFill
        style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}
      >
        <div
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 132,
            fontWeight: 700,
            color: INK_PRESS.ink,
            transform: `scale(${scale})`,
            filter: `blur(${blur}px)`,
            opacity,
            letterSpacing: "-0.02em",
            textAlign: "center",
            padding: "0 8%",
            position: "relative",
          }}
        >
          {title}
          <div
            style={{
              position: "absolute",
              left: "10%",
              right: "10%",
              bottom: -18,
              height: 8,
              background: INK_PRESS.amber,
              opacity: 0.35 + glint * 0.65,
              borderRadius: 4,
            }}
          />
        </div>
        {kicker.length > 0 ? (
          <div
            style={{
              marginTop: 56,
              fontFamily: "'Courier New', monospace",
              fontSize: 42,
              color: INK_PRESS.inkSoft,
              opacity,
              letterSpacing: "0.04em",
            }}
          >
            {kicker.slice(0, kickerChars)}
          </div>
        ) : null}
      </AbsoluteFill>
    </PaperStage>
  );
};

/** Asset showcase shot — 2.5D page-parallax reveal of a product screenshot. */
const AssetShot: React.FC<{ src: string; label: string }> = ({ src, label }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [80, 0]);
  const scale = interpolate(frame, [0, durationInFrames], [1.06, 1.0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const exit = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
  });

  return (
    <PaperStage>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            transform: `translateY(${y}px) scale(${scale})`,
            opacity: opacity * exit,
            boxShadow: "0 40px 120px rgba(30,27,22,0.35)",
            borderRadius: 18,
            overflow: "hidden",
            border: `2px solid ${INK_PRESS.paperDeep}`,
            width: "72%",
            maxHeight: "78%",
          }}
        >
          <Img src={src} style={{ width: "100%", display: "block", objectFit: "cover" }} />
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 72,
            fontFamily: "'Courier New', monospace",
            fontSize: 34,
            color: INK_PRESS.inkSoft,
            opacity: opacity * exit,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
      </AbsoluteFill>
    </PaperStage>
  );
};

/** Outro — amber wordmark settle. */
const OutroShot: React.FC<{ title: string }> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(rise, [0, 1], [40, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <PaperStage>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 96,
            fontWeight: 700,
            color: INK_PRESS.amber,
            transform: `translateY(${y}px)`,
            opacity,
          }}
        >
          {title}
        </div>
      </AbsoluteFill>
    </PaperStage>
  );
};

export const CinematicPromo: React.FC<CinematicPromoProps> = ({
  postText,
  assetDataUris,
  shots,
  audioSrc,
}) => {
  const { title, kicker } = titleAndKicker(postText);
  const titleFrames = shots[0]?.durationFrames ?? 83;
  const assetFrames = 90;
  const outroFrames = 60;

  const segments: { key: string; from: number; frames: number; node: React.ReactNode }[] = [];
  let cursor = 0;
  segments.push({
    key: "title",
    from: cursor,
    frames: titleFrames,
    node: <TitleShot title={title} kicker={kicker} />,
  });
  cursor += titleFrames;
  assetDataUris.forEach((uri, i) => {
    segments.push({
      key: `asset-${i}`,
      from: cursor,
      frames: assetFrames,
      node: (
        <AssetShot
          src={uri}
          label={`Shot ${i + 1} · ${shots[i % shots.length]?.name ?? "asset"}`}
        />
      ),
    });
    cursor += assetFrames;
  });
  segments.push({
    key: "outro",
    from: cursor,
    frames: outroFrames,
    node: <OutroShot title={title} />,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: INK_PRESS.paper }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} volume={0.6} loop /> : null}
      {segments.map((s) => (
        <Sequence key={s.key} from={s.from} durationInFrames={s.frames}>
          {s.node}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
