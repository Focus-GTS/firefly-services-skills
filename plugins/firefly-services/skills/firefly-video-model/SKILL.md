---
name: firefly-video-model
description: Generate video clips with Adobe Firefly Video Model — text-to-video and image-to-video, prompt patterns optimized for motion vs. coherence, duration and aspect ratio control, IP-safe commercial use posture, and the production workflow for inserting Firefly video into existing edit pipelines. Use whenever the user mentions "Firefly Video", "generate video", "text-to-video", "image-to-video", "motion graphics", "video clip", "video model", or wants to add Firefly-generated motion to a campaign or content workflow. The first commercially-safe AI video generation API; encodes the prompt engineering and integration patterns for production motion-graphics workflows.
license: Apache-2.0
compatibility: Requires `ff_apis` scope and Firefly Video entitlement (often a separate SKU from base Firefly Services). Endpoint: `firefly-api.adobe.io/v3/videos/generate-async`. Output is video file (typically MP4, 1080p). Generation can take 2-10 minutes per clip.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: video
---

# Firefly Video Model

The industry's first commercially-safe AI video generation API. Generates 1080p video clips from text prompts or images. Output is IP-safe for commercial use — trained exclusively on licensed content, the same trust posture as Firefly's image models.

This is a newer endpoint than image generation; rate limits are lower, generation takes longer, and prompt patterns differ. This skill encodes what we've learned in early production deployments.

## When to Use This Skill

Use this skill when:
- A campaign needs short motion clips that have to be commercially safe
- Static hero images need motion variations for social / pre-roll
- A storyboard concept needs an animatic
- The user mentions "video", "motion graphics", "animation", "Firefly Video"

Do **NOT** use this skill when:
- The user wants long-form video editing — Firefly Video generates clips (typically 5-10s), not full edits
- IP safety isn't a requirement and another model (Runway, Sora) is acceptable to the customer
- The user wants live-action footage of real people — Firefly Video generates synthetic content

## What Firefly Video Can and Can't Do

### Can
- Generate 1080p clips from text prompts (up to ~10s typical)
- Generate 1080p clips from an image as motion seed (image-to-video)
- Maintain temporal coherence over short durations
- Match camera moves (pan, zoom, dolly) via prompt
- Output in standard aspect ratios (16:9, 9:16, 1:1)

### Can't (today)
- Generate clips longer than ~10s in a single call
- Generate complex multi-shot sequences
- Lip-sync to provided audio
- Generate clips with recognizable real people
- Match a specific brand custom-trained style (no video custom models yet)

If the use case needs long-form, multi-shot, or character lip-sync, plan to use Firefly Video for B-roll / inserts only, with the rest of the edit assembled in Premiere or After Effects.

## Step 1 — Submit the Video Generation Job

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/videos/generate-async' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a slow cinematic dolly shot through a sunlit forest, dappled light, gentle camera motion",
    "size": {"width": 1920, "height": 1080},
    "duration": 5,
    "fps": 24
  }'
```

Returns the async job pattern (`jobId`, `statusUrl`, `cancelUrl`). Poll the status URL — note that video jobs take **2-10 minutes typically**, not the ~10 seconds image jobs take. Use a longer polling interval (5-15s) and a much higher max timeout (15-20 minutes).

## Step 2 — Request Shape

```json
{
  "prompt": "string — describe motion + scene + style + camera",
  "size": {"width": 1920, "height": 1080},
  "duration": 5,
  "fps": 24,
  "seeds": [12345],
  "image": {"source": {"uploadId": "abc-123"}},
  "contentClass": "photo | art"
}
```

| Field | Notes |
|---|---|
| `prompt` | The most-important field; see prompt patterns below |
| `size` | Aspect ratios: 1920×1080 (16:9), 1080×1920 (9:16), 1080×1080 (1:1) |
| `duration` | Seconds; max ~10 today |
| `fps` | 24 / 30 / 60; 24 for cinematic, 30 for social, 60 for sports/motion |
| `seeds` | Same seed = same output, useful for reproducibility |
| `image` | Optional — when provided, output animates *from* this image |
| `contentClass` | `photo` for live-action style; `art` for stylized |

## Step 3 — Prompt Patterns for Video

Video prompts differ from image prompts. The model needs to know **motion**, not just scene composition.

### Structure: subject + setting + motion + camera + style

```
[Subject] in [setting], [what the subject is doing], [camera motion], [visual style]
```

### Examples

| Use | Prompt |
|---|---|
| Product shot with motion | "A sleek black smartphone rotating slowly on a marble pedestal, soft studio lighting, camera circling clockwise, photorealistic" |
| B-roll for tech ad | "A close-up of fingers typing on a backlit keyboard, shallow depth of field, subtle warm tone, gentle dolly in" |
| Brand lifestyle | "Two friends laughing on a city rooftop at golden hour, hand-held camera with subtle sway, wide cinematic frame, photorealistic" |
| Animated illustration | "A flat-design illustration of a paper airplane flying across a pastel sky, smooth horizontal motion, slight rotation, 2D animation style" |
| Storyboard animatic | "A simple storyboard sketch of a person walking up to a door and reaching for the handle, line-art style, minimal motion" |

### Camera move vocabulary the model understands

- `dolly in` / `dolly out` — camera moves toward / away
- `pan left` / `pan right` — camera rotates horizontally
- `tilt up` / `tilt down` — camera rotates vertically
- `tracking shot` — camera follows subject
- `static shot` — camera stays still
- `aerial shot` / `drone shot` — top-down or overhead
- `whip pan` / `crash zoom` — fast, aggressive moves

### Anti-patterns

Avoid:
- "Suddenly the subject does X" — Firefly Video struggles with discrete narrative events; a single sustained motion works better
- Multiple simultaneous motions ("the dog runs while the camera spins while the background changes") — pick one dominant motion
- Long sequences ("first this happens, then this happens") — generate two clips instead

## Step 4 — Image-to-Video

Provide a source image and Firefly will generate motion from that frame:

```json
{
  "prompt": "gentle camera pull-back revealing more of the scene, subtle wind moving the trees",
  "image": {"source": {"uploadId": "$SOURCE_IMAGE_ID"}},
  "size": {"width": 1920, "height": 1080},
  "duration": 5
}
```

Image-to-video is the production pattern for **motion variants of approved hero stills** — you've already approved the static image; the video is just adding motion to it.

The source image must match the target aspect ratio. Generate or expand the image first if needed.

## Step 5 — Output and Download

Successful job response:

```json
{
  "status": "succeeded",
  "result": {
    "outputs": [
      {
        "video": {
          "url": "https://pre-signed-cdn-url..."
        },
        "thumbnail": {"url": "..."},
        "duration": 5,
        "format": "mp4"
      }
    ]
  }
}
```

Download the MP4 immediately and re-host. URLs expire (typically 1 hour).

Video files are larger than images — a 1080p 5-second clip is typically 5-15MB. Plan storage and CDN bandwidth accordingly.

## Production Patterns

### Pattern: Motion variants of approved heroes

```
1. Image team approves a hero still
2. Image-to-video, 3 different motion prompts (subtle, medium, dramatic)
3. Creative team picks one
4. Picked variant goes to edit pipeline as B-roll
```

This pattern avoids the "is the moving version actually approvable" risk — the still is locked first, then motion is layered.

### Pattern: Animatic generation for storyboards

```
For each storyboard frame:
  1. Generate or upload a sketch/key-art for the frame
  2. Image-to-video with simple motion ("subtle zoom" / "slow pan")
  3. Concat clips in After Effects or ffmpeg
```

Output is an animatic — not a final cut, but a directional reference for the live-action shoot or final animation.

### Pattern: Social pre-roll variants

```
1. Approved hero image (1:1 or 16:9)
2. Generate 5 variants with different motion:
     - Subtle zoom in
     - Slow pan left to right
     - Tilt up revealing more of the scene
     - Static with subtle parallax
     - Dolly forward
3. A/B test on social
```

Five short clips from one hero image. The cost is fixed (5 generation calls), the output is varied enough for meaningful A/B testing.

## Rate Limits and Cost

Video generation is more expensive than image generation in compute time and quota:

| Metric | Approximate |
|---|---|
| Time per clip | 2-10 minutes typically |
| RPM limit | Lower than image (~1 RPM default) |
| Cost per credit | Higher than image (consult Adobe pricing) |
| Concurrent jobs | 1-2 per credential default |

Plan video workloads with longer polling intervals (5-15s), wider rate-limit headroom, and async webhooks if available. Treat each video job as a multi-minute commitment, not a request-response.

## IP Safety — The Differentiator

Firefly Video is the **first commercially-safe AI video generation API**. It is trained exclusively on:

- Licensed Adobe Stock content
- Public-domain content
- Openly-licensed content

Output is covered by Adobe's IP indemnification for commercial use. This is the reason a Fortune-500 customer would choose Firefly Video over Runway, Sora, or open-source models — even with lower output quality, the IP indemnification is irreplaceable for commercial campaigns.

Document this with the customer's legal team. The Firefly Video output is reviewable; the indemnification is contractual.

## Validate

A Firefly Video pipeline is production-ready when:

1. Customer has the Firefly Video entitlement (verify SKU before building)
2. Generation jobs are tracked with appropriate timeouts (15-20 min max)
3. Output MP4s are downloaded and re-hosted within the URL expiry window
4. Prompts follow the structured pattern (subject + setting + motion + camera + style)
5. Use case is appropriate for clip-length output (not long-form)
6. Legal sign-off acknowledges IP indemnification posture

## Troubleshooting & Edge Cases

- **Output has incoherent or "morphing" subjects:** Prompt is too complex. Simplify to one subject + one motion.
- **Output is shorter than requested duration:** Adobe may clip if temporal coherence is breaking down. Try shorter duration or reduce motion complexity.
- **Job stuck for 15+ minutes:** Cancel and resubmit. Long stalls are rare but happen during peak load.
- **`size` rejected:** Use the published aspect ratios (1920×1080, 1080×1920, 1080×1080). Custom dimensions not supported.
- **`duration` rejected as too high:** Max changes over time as the model improves. Currently ~10s; check release notes for current ceiling.
- **Content safety filter triggers on a clean prompt:** Synthetic video has stricter safety filters than image. Strip any reference to people, brands, or sensitive themes and try again.
- **Image-to-video output ignores the source:** Source image may not match the target aspect ratio. Pre-process to the exact target size.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Source image upload for image-to-video
- `firefly-generate-image-v3-async` — Generate the source image first
- `firefly-services-rate-limits` — Video quota is lower; plan capacity
- `firefly-services-troubleshoot` — Errors are usually safety-filter or rate-limit

## References

- [Firefly Video Model — Adobe announcement](https://www.adobe.com/products/firefly/features/ai-video-generator.html)
- [Firefly API Documentation Hub](https://developer.adobe.com/firefly-services/docs/firefly-api/)
- [Firefly Services Trust and Safety](https://www.adobe.com/legal/licenses-terms/adobe-gen-ai-user-guidelines.html)
