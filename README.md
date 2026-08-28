# CareSense server — finalized backend

The server ingests ZIP batches, asynchronously transcribes accepted recordings with speaker diarization and timestamps,
then micro-batches completed transcripts for structured OpenAI analysis.

For each valid `audio + metadata` pair the API:

1. validates the metadata contract;
2. upserts the customer and agent by their external IDs;
3. streams only the MP3/WAV object to Cloudflare R2;
4. stores its object URL and raw metadata in PostgreSQL;
5. creates the recording with `validation_status = NOT_DONE`;
6. writes a transactional transcription outbox entry so the recording is queued reliably.

Unsupported, missing, duplicate, and malformed entries are persisted in `batch_file_staging` and are never uploaded to R2. One bad pair does not prevent other valid pairs from being ingested.

## ZIP contract

```text
batch.zip
├── Conv1.mp3
├── Conv1_meta.json
├── Conv2.wav
└── Conv2_meta.json
```

The session format pairs metadata to audio using its exact `audio_file` value. The original format from `Project-intel.txt` remains supported through exact filename stems.

CallRadar archives may instead use sibling `metadata/<sid>.json` and `audio/<sid>.mp3` entries. Their stereo contract is fixed: the left channel is the agent and the right channel is the customer. Source speaker IDs are retained on every recording for traceability.

For session metadata, the service reads customer and agent IDs from their nested `metadata` objects, converts `start_time_ms` to UTC, defaults missing language from `DEFAULT_CALL_LANGUAGE`, and retains the complete original JSON.

## Local setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

Start the worker in a second terminal:

```bash
npm run worker
```

Reset all CareSense test data, Redis queues, local staging files, and R2 recordings:

```bash
npm run flush:all -- --yes
```

To truncate only operational PostgreSQL data while retaining settings, migration history, queues, staging, and R2 objects:

```bash
npm run truncate:data -- --yes
```

To clear only Redis and every BullMQ queue state:

```bash
npm run flush:queues -- --yes
```

The reset command is disabled in production and preserves `application_settings` and `schema_migrations`. Stop active
API and worker processes before running it so no in-flight upload or AI request can write data during the reset.

The worker uses local Redis on port 6380, processes up to four OpenAI transcription requests concurrently,
and analyzes up to four ready calls per request with `gpt-5.6-luna`. Partial analysis groups are released after
`ANALYSIS_GROUP_MAX_WAIT_MS`, so a small batch does not wait indefinitely.

After every analyzable call reaches a terminal analysis state, customer-scoped recurrence jobs load that customer's
analyzed call summaries from the configurable lookback window. When at least two calls exist, Luna uses strict
Structured Outputs to group only calls discussing the same underlying issue; unrelated calls from the same customer
remain separate. The combined summary, verdict, recommended action, model version, and ordered call references are
stored in PostgreSQL. Advisory locks prevent concurrent batches for one customer from racing.

The project PostgreSQL container is exposed on port 5433 to avoid conflicting with an existing local database. Cloudflare R2 credentials are read from `.env`.

## Upload

```bash
curl -X POST http://localhost:3000/api/v1/upload-batches \
  -F 'archive=@./batch.zip'
```

To display an explicit upload percentage, use the included client:

```bash
npm run upload:batch -- ./batch.zip
```

Retrieve the result and rejected-file names:

```bash
curl http://localhost:3000/api/v1/upload-batches/BATCH_UUID
curl http://localhost:3000/api/v1/upload-batches/BATCH_UUID/staging-errors
```

The upload returns HTTP `202` after the ZIP transfer and queue handoff. Ingestion and transcription continue asynchronously. Poll `status_url` or subscribe to `events_url` for live progress.

Because processing is asynchronous, the upload request still returns HTTP `202`. A batch that later fails moves to `processing_state = FAILED`; its status resource includes `failure_reason` and `failure_details`. Expected reasons include `ALL_CALLS_FAILED` and `ARCHIVE_PROCESSING_FAILED`; partial batches expose their individual failures separately.

The status resource exposes separate counters for `ingestion`, `transcription`, `analysis`, and `textual_tone`, plus
`processing_percentage`. The SSE endpoint emits the same snapshot whenever it changes.

Cancellation is terminal and idempotent for an already-cancelled batch. Pending ingestion, transcription, analysis,
and recurrence jobs are removed. A provider request already in flight may finish remotely, but workers check the
cancelled state before saving results, so no later stage is started for that batch.

## Upload percentage

Upload percentage is measured on the client, independently from server processing. A browser/Node client using Axios can report it as follows:

```ts
const form = new FormData();
form.append('archive', zipFile);

await axios.post('/api/v1/upload-batches', form, {
  onUploadProgress(event) {
    if (event.total) console.log(Math.round((event.loaded / event.total) * 100));
  }
});
```

This is the accurate byte-transfer percentage. The batch endpoints report processing and validation results after the upload reaches 100%.

## Size and duplicate validation

- `MAX_UPLOAD_BYTES` is a separate archive safety limit and defaults to 1 GiB; it is not the per-call 12 MiB limit.
- `MAX_INGEST_FILE_BYTES=12582912` applies independently to every uncompressed MP3, WAV, and metadata JSON entry.
- Oversized audio or metadata is never uploaded to R2 or made eligible for transcription. It is stored in `failed_calls` with `failure_reason = SIZE_EXCEEDED`.
- Only MP3/WAV audio and `_meta.json` metadata are eligible. Unsupported formats are stored with `UNSUPPORTED_FORMAT`; malformed or schema-invalid JSON is stored with `INVALID_METADATA`.
- Rejected items are isolated: other valid calls in the same ZIP continue processing.
- Audio without metadata is stored in `failed_calls` as `MISSING_METADATA`; metadata with no referenced audio is stored as `MISSING_AUDIO`. Neither case creates a processable call.
- Duplicate recording content is detected with a SHA-256 checksum, not the filename. Renaming an identical audio file does not bypass duplicate detection.
- For duplicates within one ZIP, the first occurrence is accepted and each later occurrence is skipped.
- Skipped duplicates are inserted into `failed_calls` with `failure_reason = DUPLICATE_CALL`, their own call ID, checksum, and `duplicate_of_external_call_id`. They are not uploaded to R2.

## API

- `POST /api/v1/upload-batches` — stream one ZIP in multipart field `archive`
- `GET /api/v1/upload-batches/:batchId` — batch counters and state
- `GET /api/v1/upload-batches/:batchId/staging-errors` — unwanted/missing/invalid filenames
- `GET /api/v1/upload-batches/:batchId/failed-calls` — files excluded from downstream processing, including size failures
- `GET /api/v1/upload-batches/:batchId/events` — SSE batch progress
- `POST /api/v1/upload-batches/:batchId/cancel` — stop an active batch and remove its pending queue jobs
- `GET /api/v1/calls/:callId/transcription` — transcript and ordered timestamped speaker segments
- `GET /api/v1/calls/:callId/analysis` — title, issue classification, rule booleans, urgency, and analysis state
- `GET /api/v1/calls` — paginated/filterable manager call list
- `GET /api/v1/calls-grouped` — call-list rows with each confirmed recurring group collapsed into one row
- `GET /api/v1/calls/:callId` — complete metadata, rules, segments, tones, alert, and recurrence detail
- `GET /api/v1/recurring-groups/:groupId` — combined recurrence review and ordered call timeline
- `GET /api/v1/calls/:callId/audio` — R2-backed audio proxy with HTTP byte-range support
- `GET /api/v1/dashboard/home` — daily KPIs, yesterday comparison, weekly volume, banking-product/enquiry rankings, and today's recurring/rude calls
- `GET /api/v1/dashboard/team` — agents active on the selected day with call and resolution totals
- `GET /api/v1/agents/:agentId/calls` — one agent's paginated calls and unchanged seven-rule etiquette results for the selected day
- `GET /api/v1/settings` — recurrence window, ideal call duration, and enabled etiquette rule keys
- `PATCH /api/v1/settings` — update one or more application settings
- `GET /api/v1/manager-alerts` — paginated manager-attention queue
- `PATCH /api/v1/manager-alerts/:alertId` — update alert status and notes
- `GET /health` — process liveness
- `GET /ready` — PostgreSQL, Redis, and Cloudflare R2 readiness

## Security limits

The service streams the multipart ZIP to a private temporary file, checks ZIP paths, limits compressed bytes, metadata bytes, and entry count, and streams accepted audio from ZIP to Cloudflare R2. Adjust limits in `.env`; no uploaded file is loaded wholesale into memory.

R2 objects should remain private. Without `R2_PUBLIC_BASE_URL`, `recording_url` stores the stable R2 HTTPS object location, but accessing a private object still requires a signed request. A protected download API can be introduced later.

## Phase 3 analysis

After a transcript is committed, the same database transaction adds it to `analysis_outbox`. The worker groups up to four
ready calls and requests strict JSON Schema output from OpenAI. Results are matched by immutable call and segment UUIDs;
missing, duplicate, or unexpected IDs reject the entire response instead of writing mismatched annotations.

Rules are stored in `call_evaluations`. Overall classifications are stored on `call_recordings`, and each tone is stored in
`transcript_segments.textual_tone`. Calls requiring attention create an idempotent `manager_alerts` row. A grouped request
that exhausts its retries is split into one-call groups, isolating a persistently bad call from the rest of the batch.

## Full Docker deployment

PostgreSQL and Redis alone:

```bash
docker compose up -d postgres redis
```

Build and run migrations, API, worker, PostgreSQL, and Redis:

```bash
docker compose --profile app up -d --build
```

The `migrate` service exits after applying pending SQL files. `api` and `worker` start only after migration succeeds.
The local `.env` is injected at runtime and excluded from the container image.

## Call-list filters

`GET /api/v1/calls` supports `batch_id`, `customer_id`, `agent_id`, `issue_category`, `resolution_status`,
`call_status`, `needs_manager_attention`, `urgency_level`, `processing_state`, `started_from`, `started_to`, `page`,
and `page_size`. Page size is capped at 100.

`banking_product` filters calls by product. The legacy `device_model` query and response field remain temporarily available only for backward compatibility with previously accepted metadata.

Example:

```bash
curl 'http://localhost:3000/api/v1/calls?call_status=RUDE&needs_manager_attention=true&page_size=25'
```

## Dashboard and team APIs

Dashboard dates are interpreted as calendar days in the requested IANA timezone. `date` defaults to the current date
and `timezone` defaults to `Asia/Kolkata`.

```bash
curl 'http://localhost:3000/api/v1/dashboard/home?date=2026-08-20&timezone=Asia%2FKolkata'
curl 'http://localhost:3000/api/v1/dashboard/team?date=2026-08-20&timezone=Asia%2FKolkata'
curl 'http://localhost:3000/api/v1/agents/ALLREC-AGENT-ARJUN/calls?date=2026-08-20&timezone=Asia%2FKolkata&page=1&page_size=25'
```

Home rates use all calls on the selected day as their denominator. Resolved, recurring, and rude are independent
classifications and may overlap. `flagged_calls` contains today's calls tagged `RECURRING` or `RUDE`.

Team results include call count, resolved/unresolved/dropped/escalated counts, calls requiring attention, average
duration, and resolution rate for each active agent. Agent-call results retain the seven backend etiquette booleans;
all of them evaluate agent behavior only.

## Application settings

Runtime business settings are stored in the singleton `application_settings` PostgreSQL row instead of `.env`.
The defaults are a 10-day recurring-call lookback and a 300-second ideal call duration. The etiquette array contains
the enabled keys from the fixed seven-rule backend contract.

```bash
curl http://localhost:3000/api/v1/settings

curl -X PATCH http://localhost:3000/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{"recurring_lookback_days":10,"ideal_call_duration_seconds":300}'
```

Changing `recurring_lookback_days` clears existing recurrence links and queues analyzed calls for recalculation. The
dashboard home response returns `average_duration.seconds`, `target_seconds`, and `difference_seconds`.
