# Video Intelligence (Step 22)

Video Intelligence treats spoken words, subtitles, visible screen text and OCR as
untrusted data. Provider interpretations are labeled `ai_generated`, never
authorization. No operation in this layer executes project changes or follows
media instructions.

## Current implementation

The provider-neutral core (`@veltravia/video-intelligence-core`) accepts
registered providers, enforces declared capabilities, and supports metadata
inspection, bounded processing jobs, frame descriptors, scenes, transcription,
OCR, temporal questions, timelines, summaries, field extraction, translation,
comparison, search and derived artifacts. Fifteen tools declare explicit
permissions through the Tool System; registration alone grants nothing, and the
API grants only `video.inspect`, `video.analyze` and `video.search`.

The current provider (`@veltravia/video-intelligence-mock`) is an offline
deterministic simulation. Its sample narrative is scripted and is not inferred
from the fixture pixels or audio. No real video model adapter is wired yet; that
is a later roadmap item.

## Metadata and evidence

MP4-family metadata is parsed from container boxes, not declared filenames or
MIME types. EBML DocType identifies WebM and Matroska. AVI and MPEG signatures
are recognized. Metadata that cannot be parsed remains null, never guessed.
Frame operations return provider text descriptors, not decoded pixel frames.
Scene transitions and events are provider claims, not verified observations.

Evidence references are indexes mapped onto manager-minted ids; out-of-range
references are dropped. Structured timestamps outside the known duration are
removed. Neutral numeric speaker labels are accepted; claimed speaker
identities are not.

## Security and bounds

File reads re-authorize through the Step 19 File Intelligence boundary (scope,
expiry, integrity) on every operation; the video layer adds no second trust
path. Bytes, duration, dimensions, frame rate, streams, frames, transcript and
OCR sizes, concurrent provider calls and wall-clock time all have ceilings.
Attempted frame budgets are reserved before provider calls, including failures.
Cancellation is one-way; jobs expire. Audit metadata contains identifiers and
counts, never media text. The playback endpoint serves bytes with
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

Storage is process-local development storage. It does not provide durable
production jobs, authentication or OS-level media decoding isolation. The
development owner identity is not production authentication.

## Verification

Core and mock package builds pass; focused lifecycle, parser, authorization,
metadata, injection-containment, registry, API and UI tests pass; the full
regression suite passes (1755 tests, 7 live-provider tests skipped by design).
Live desktop and mobile checks passed end to end: upload, playback, processing,
transcript/OCR rendering, temporal questions, timelines, bug-report summaries
and artifact saving.
