// Effect pool ported verbatim from dev-tools/video/make-cycle-video.sh.
// 44 distinct looks; each entry is a filterchain applied after scale/crop to WxH.
// The placeholder __DT__ is replaced with the actual frame count (fps * seg_sec)
// before the string is used in an ffmpeg argument array.

/**
 * Raw effect filter strings from the bash engine.
 * Use substituteEffectParams() before embedding into an ffmpeg filter graph.
 * __DT__ → frame-count integer (fps * seg_sec).
 * W and H are NOT substituted here — they are expanded via explicit scale params.
 */
export const EFFECT_POOL: readonly string[] = [
  "hue=h='60*t':s=1.5",
  "hue=h='-90*t':s=1.7",
  "gblur=sigma=10,eq=saturation=1.7:contrast=1.15",
  "boxblur=12:1,eq=saturation=1.5",
  "rgbashift=rh=10:bv=-10,eq=saturation=1.8",
  "rgbashift=rh=-14:gh=8:bv=12",
  "edgedetect=low=0.1:high=0.3,negate,hue=h='120*t':s=2.0",
  "negate,hue=h='80*t':s=1.5",
  "vignette=PI/4,hue=h='70*t':s=1.6,eq=brightness=0.03",
  "noise=alls=14:allf=t,hue=h='-50*t':s=1.5",
  "zoompan=z='min(1+0.025*on,1.5)':d=__DT__:s=1280x720,eq=saturation=1.4",
  "zoompan=z='if(lte(on,1),1.5,max(1.5-0.025*on,1))':d=__DT__:s=1280x720,hue=h='40*t'",
  "rotate='0.06*sin(t*1.5)':c=black,eq=saturation=1.5",
  "pixelize=w=12:h=12,hue=h='90*t':s=1.6",
  "pixelize=w=24:h=24,eq=saturation=1.8",
  "lutyuv=y='val*1.1':u='128+1.4*(val-128)':v='128+1.4*(val-128)',hue=h='50*t'",
  "curves=preset=vintage,hue=h='30*t'",
  "curves=preset=cross_process,eq=saturation=1.4",
  "colorbalance=rs=0.3:gs=-0.1:bs=0.2,hue=h='60*t'",
  "colorbalance=rs=-0.2:bs=0.4,eq=saturation=1.6",
  "colorchannelmixer=2:0:0:0:0:1:0:0:0:0:1:0,hue=h='70*t'",
  "gradfun=3.5:8,eq=saturation=1.7:contrast=1.2",
  "unsharp=7:7:2.5,hue=h='-60*t':s=1.6",
  "prewitt,negate,hue=h='100*t':s=2.0",
  "sobel,hue=h='140*t':s=1.8",
  "erosion,hue=h='50*t':s=1.5",
  "dilation,eq=saturation=1.7,hue=h='-40*t'",
  "split=2[a][b];[b]crop=iw/2:ih:0:0,hflip[bf];[a][bf]overlay=W/2:0,hue=h='45*t'",
  "split=2[a][b];[b]crop=iw:ih/2:0:0,vflip[bf];[a][bf]overlay=0:H/2,hue=h='-45*t'",
  "transpose=2,transpose=1,hue=h='80*t':s=1.5",
  "lenscorrection=k1=-0.3:k2=-0.1,hue=h='60*t':s=1.6",
  "lenscorrection=k1=0.3:k2=0.1,eq=saturation=1.7",
  "rotate='0.04*sin(t*2)':c=black,rgbashift=rh=8:bv=-8,hue=h='50*t'",
  "tblend=all_mode=difference,hue=h='120*t':s=2.0",
  "colorbalance=rm=0.3:gm=-0.2:bm=0.3,hue=h='80*t':s=1.5",
  "eq=brightness='0.12*sin(t*2)':contrast=1.3:saturation=1.6,hue=h='70*t'",
  "eq=brightness='0.1*sin(t*3)':saturation='1.5+0.6*sin(t/2)':contrast=1.2",
  "convolution='0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 0 0 0 1 0 0 0 0',hue=h='40*t'",
  "gblur=sigma=6,negate,curves=preset=vintage,hue=h='90*t'",
  "hue=h='180*t':s='1.5+0.8*sin(t*2)'",
  "rgbashift=rh=6:gh=-6:bv=6,vignette=PI/5,hue=h='-70*t'",
  "noise=alls=8:allf=t+u,curves=preset=cross_process",
  "pixelize=w=16:h=16,negate,hue=h='110*t':s=1.9",
  "colorchannelmixer=0:1:0:0:0:0:1:0:1:0:0:0,hue=h='60*t'",
] as const;

/**
 * Fisher-Yates shuffle (in-place). Uses a seedable PRNG when seed is provided.
 * Returns the same array (mutated) for convenience.
 */
export function fisherYates<T>(arr: T[], seed?: number): T[] {
  // Seedable xorshift32 PRNG (same statistical quality as bash $RANDOM).
  let s = seed !== undefined ? (seed >>> 0) || 1 : (Date.now() >>> 0) || 1;
  const rand = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };

  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    const tmp = arr[k];
    arr[k] = arr[j] as T;
    arr[j] = tmp as T;
  }
  return arr;
}

/**
 * Build a shuffled sequence of effect indices of exactly `count` length.
 * When count > pool size, the pool is re-shuffled and appended in passes
 * (matching the bash engine behaviour).
 */
export function buildEffectSequence(count: number, seed?: number): number[] {
  const pool = [...EFFECT_POOL.keys()]; // [0, 1, ..., 43]
  fisherYates(pool, seed);

  const seq: number[] = [];
  while (seq.length < count) {
    seq.push(...pool.slice(0, count - seq.length));
    if (seq.length < count) {
      fisherYates(pool); // re-shuffle for the next pass
    }
  }
  return seq;
}

/**
 * Replace the __DT__ placeholder in an effect string with the actual frame count.
 * This is the ONLY substitution performed — no user strings enter here.
 */
export function substituteEffectParams(effect: string, dt: number): string {
  return effect.replaceAll("__DT__", String(dt));
}
