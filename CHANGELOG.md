# Changelog

All notable changes to this project are documented here. Versions follow `YYYY.M.PATCH`.

## 2026.9.0

First release.

### SSL Labs node

- **Assessment → Analyze** has three modes: Wait for Result, Start Only and Get Status. It returns a Summary (worst, best and per-endpoint grades, leaf certificate with days until expiry, and report URL) or the Full raw host.
  - Pasted URLs are reduced to their hostname.
  - Force New Scan and Use Cache cannot both be on. The UI prevents it and the node checks it again at runtime.
  - Publish Results is off by default.
- **Batching.** The node reads `/info` once per batch and keeps concurrency within the free assessment slots (default 3, max 10). It spaces new assessments by `newAssessmentCoolOff`, supports Continue On Fail, and aborts the rest of the batch on the first failure otherwise.
- **Endpoint → Get**, plus **Service → Get Info / Get Status Codes / Get Root Certificates**.
- **Registration → Register.** Works without a credential.
- **Retries.**
  - 429, 503 and 529 are retried with bounded, jittered backoff; 500 is retried once.
  - 400 is never retried, and a `startNew` call is never repeated.
  - Retry waits stop at the Wait-for-Result timeout.
- **Unregistered email.** The error is translated into "use the Register operation first".

### SSL Labs Trigger

- A polling trigger with three events: Grade Changed, Grade Below Threshold (fires once on crossing, re-arms on recovery) and Certificate Expiring (fires once per certificate, re-arms on renewal).
- It never waits for a scan during a poll. It reads cached results, tracks pending hosts, waits `newAssessmentCoolOff` after starting an assessment, backs off when SSL Labs is busy, and stays within the poll budget.
- A host that keeps failing cannot block the others. Configuration errors (unregistered email, a non-https base URL, 401/403/404, or every host unreachable) fail the poll instead of passing silently.
- The first run is a silent baseline. The stored state is versioned (`stateVersion: 1`).

### Credential

- **SSL Labs API**: the registered email is sent as the `email` header. The base URL must use https, and the dev server can be selected.
