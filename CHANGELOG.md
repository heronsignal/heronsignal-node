# Changelog

## 0.2.0 (2026-08-13)

Everything below has been sitting on `main` since 0.1.2 went out on 4 July.
The version was never bumped, so the `0.1.2` on npm and the `0.1.2` in this
repository were different code with the same number. This release ends that.

Still `0.x`: `types.ts` changed twice in five weeks, so the interface has not
earned the promise that 1.0.0 makes.

### Fixed

- **`init()` no longer leaks a timer per call.** Each call started a flush
  interval and nothing cleared the previous one. On a long-lived server you
  paid for that once, but on Vercel Edge or Cloudflare Workers, where init can
  run per request, it accumulated for the life of the isolate.
- **Works on the Edge runtime.** The client reached for Node built-ins that do
  not exist there, so importing it in Next.js middleware threw at module load.
- **Events survive a transient backend failure.** Sends now retry with
  backoff instead of dropping the batch on the first non-2xx.
- **`flush()` no longer races itself.** Two overlapping flushes could send the
  same events twice or lose the ones queued between them, which mattered most
  in the shutdown path where a flush is exactly what you are relying on.
- **Broader redaction.** More key shapes are treated as sensitive before
  anything leaves the process.
- Session correlation documents the header the ADR settled on,
  `x-heronsignal-session`. The old name still worked but the docs disagreed
  with the backend.

### Notes

- `engines.node` stays at `>= 18`.
- No runtime dependencies.
- 15 tests, all passing, including one that asserts no background timer is
  created when `flushIntervalMs` is 0.

## 0.1.2 (2026-07-04)

- Payment-journey example covering session correlation, plus the matching
  README section.

## 0.1.1 (2026-07-04)

- Re-release. 0.1.0 was tombstoned by an unpublish and npm does not allow the
  number to be reused.
