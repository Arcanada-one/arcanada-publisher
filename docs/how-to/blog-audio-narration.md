# How to: blog audio narration (RU Silero + EN Kokoro)

A blog post with the audio player needs one MP3 per voice: 5 RU voices (Silero)
plus 1 EN voice (`af_heart`, Kokoro). The generator lives in the **landing repo**
(`Projects/Arcanada Ecosystem/code/landing/ops/gen-blog-audio.py`), not in this
Publisher repo — but the *rules* for preparing the narration text are a publishing
concern and are mirrored in `skills/publishing/SKILL.md` § "Blog audio narration —
TTS text prep". This page is the operational recipe.

## The core rule: normalize the RU text, do not strip it

Silero is **Cyrillic-only**. It cannot speak Latin words, bare numbers, currency,
fractions, or percentages, and a digit/symbol "soup" makes it return HTTP 500.
The stock `gen-blog-audio.py` extractor takes the path of least resistance and
**strips** those tokens with a regex. That is fine for benchmark tables (raw
latency/price numbers carry no spoken value) but **wrong for a narrative article**:
the listener hears gaps where "340 tasks", "$14", "MacBook", "Datarim" should be.

So a narrative post needs a normalization pass before TTS:

1. **Numbers → Russian words** — `num2words(n, lang="ru")`. `340`→«триста сорок»,
   `33%`→«тридцать три процентов», `5,1`→«пять и одна десятых». For `$14`, emit
   just the number when the source already writes «долларов» (else doubled word).
2. **Latin → Cyrillic phonetics** — a transliteration map, never raw Latin:
   `Arcanada`→Арканада, `Datarim`→Датарим, `Muneral`→`М+унерал`, `Coworker`→Коворкер,
   `Telegram`→Телеграм, `Claude`→Клод, `README`→ридми, `PRD`→пи-эр-ди,
   `L4`→эль-четыре, `CLAUDE.md`→Клод эм-дэ (no «точка» — see rule 4). Drop any leftover Latin to space.
3. **Stress markers** — Silero mis-stresses many common words. Force the stress with
   `+` placed **before** the stressed vowel, stem-based across inflections:
   `второй`→`втор+ой`, `месяц`→`м+есяц`, `уже`(adverb)→`уж+е`. Keep a stress
   dictionary and grow it as listening reveals more (ordinals, homographs, names).

4. **Pauses** — Silero renders an em/en dash (— / –) as a *long* pause; replace
   with a hyphen `-` for a short break (measured ~1.30 s dash vs ~1.16 s hyphen).
   A dotted filename like `CLAUDE.md` voiced as «...точка эм-дэ» puts a heavy pause
   on «точка» — drop it: «Клод эм-дэ».
5. **Currency** — `$14` must become «четырнадцать долларов» (emit the word
   "долларов"); collapse any accidental doubling if the source already has it.

EN (Kokoro) needs none of this — it speaks Latin and numbers in English natively.
Normalize the RU text only.

### Verifying a stress marker without ears

Synthesize the word with and without the marker and compare the MP3/WAV bytes
(md5). **Identical** bytes → Silero already stresses that syllable (marker is
redundant or in the wrong spot). **Different** bytes → the marker moved the stress.
Example: `второй` and `вт+орой` produce the same bytes (Silero defaults to first
syllable), while `втор+ой` differs — so `втор+ой` is the correct fix.

## Running the generation

### Sidecar tunnel + token

Both RU and EN go to the speech sidecar's `/tts`, reached over an SSH tunnel
(the sidecar binds an internal Docker IP, not the host). Recipe:

```bash
# token = SPEECH_INTERNAL_TOKEN from the speech container env:
TOKEN=$(ssh root@<sidecar-host> \
  'docker exec <speech-container> printenv SPEECH_INTERNAL_TOKEN')

# tunnel to the sidecar's INTERNAL ip:port (find it via docker inspect — the
# default 172.22.0.3 in the script drifts; confirm the real IP each time):
ssh -f -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
  -L 18000:<sidecar-internal-ip>:8000 root@<sidecar-host>

export BLOG_AUDIO_SIDECAR_URL=http://localhost:18000
export BLOG_AUDIO_SIDECAR_TOKEN="$TOKEN"
export BLOG_AUDIO_MAX_CHUNK_CHARS=600   # smaller than the 900 default — see below
```

> The tunnel is the fragile part. Under sustained load it drops with
> `Connection refused` / `URLError`. Use `ServerAliveInterval`, run RU and EN
> **sequentially** (not in parallel — parallel load kills it faster), and make
> the job resumable by skipping voices whose MP3 already exists.

### Chunking

Keep chunks **≤600 chars**, not the 900 default. Long chunks trip Silero's
length-limit 500 even after one split; the generator self-heals by recursively
halving, but small chunks avoid wasted retry rounds. `MAX_CHUNK_CHARS` is
env-overridable (`BLOG_AUDIO_MAX_CHUNK_CHARS`).

## Upload + cache purge (mandatory)

MP3s live on **Cloudflare R2** (bucket `arcanada-mc-images`, prefix `blog/<slug>/`)
and are served from `cdn.arcanada.ai` with a **1-year `immutable`** cache.

- The idempotent uploader `ops/p4-upload-to-r2.sh` **skips** keys that already
  exist. To **overwrite** a re-voiced asset, upload it directly with boto3
  (`upload_file`) — the skip-logic will not replace it otherwise.
- **After any overwrite you MUST purge the Cloudflare cache** for those URLs, or
  the old narration keeps playing for up to a year. Use the token that has
  `Cache Purge:Purge` (the "Edit zone DNS API token", not the R2 `cfut_` token).
  Listeners should also hard-refresh the browser (Cmd+Shift+R).

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" \
  -H "Authorization: Bearer $PURGE_TOKEN" -H "Content-Type: application/json" \
  --data '{"files":["https://cdn.arcanada.ai/blog/<slug>/ru-xenia.mp3", ...]}'
```

## Register the voices

Add the post to `pages/blog/audio-manifest.php`:

```php
'<slug>' => [
    'ru' => ['xenia', 'baya', 'kseniya', 'aidar', 'eugene'],
    'en' => ['af_heart'],
],
```

Then `./deploy.sh` and purge the article page URLs. The player builds CDN URLs as
`{cdn}/blog/{slug}/{lang}-{voice}.mp3` (see `templates/audio-player.php`).

## See also

- `skills/publishing/SKILL.md` § Blog audio narration — the mirrored rule.
- `docs/how-to/animated-cover-video.md` — the social-post video uses one of these
  narration MP3s as its audio track (regenerate the video if you re-voice).
