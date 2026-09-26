# @t0mer/n8n-nodes-ssllabs

An [n8n](https://n8n.io/) community node for the [Qualys SSL Labs API v4](https://github.com/ssllabs/ssllabs-scan/blob/master/ssllabs-api-docs-v4.md). It runs SSL/TLS server assessments, returns grades, endpoint details and certificate data, and watches your hosts for grade or certificate changes.

It ships two nodes and one credential:

| | |
|---|---|
| **SSL Labs** | Action node: run assessments, read endpoint details, get service info, and register your email |
| **SSL Labs Trigger** | Polling trigger: grade changed, grade below a threshold, or certificate expiring |
| **SSL Labs API** | Credential: your registered email address and the API base URL |

> **Not affiliated with Qualys.** This is an unofficial, community-maintained node. SSL Labs is a free service provided by Qualys; use it according to the [SSL Labs terms](https://www.ssllabs.com/about/terms.html). **Only assess hosts you own or are authorized to test.**

- [Installation](#installation)
- [Registration](#registration)
- [Credentials](#credentials)
- [SSL Labs node](#ssl-labs-node)
- [SSL Labs Trigger](#ssl-labs-trigger)
- [Rate limits and timing](#rate-limits-and-timing)
- [Compatibility](#compatibility)
- [Resources](#resources)

## Installation

**From the n8n UI** (self-hosted): go to **Settings → Community Nodes → Install**, enter `@t0mer/n8n-nodes-ssllabs`, and confirm.

**From npm**, in your n8n custom nodes folder (usually `~/.n8n/nodes`):

```bash
npm install @t0mer/n8n-nodes-ssllabs
```

Then restart n8n. See the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Registration

API v4 requires every caller to register an email address once. Qualys rejects free mailbox domains such as Gmail, Yahoo or Hotmail, so use an organization address.

You can register in either of two ways:

- **With this node:** add an **SSL Labs** node and choose **Resource: Registration → Register**. Fill in first name, last name, email and organization, then run it. This operation does not need a credential; if you attach one, its base URL is used. Any rejection message from SSL Labs is shown as-is.
- **With the official CLI:** build and run `ssllabs-scan-v4-register` from the [ssllabs-scan](https://github.com/ssllabs/ssllabs-scan) repository. Its README lists the flags it takes.

You only register once per email address.

## Credentials

Create an **SSL Labs API** credential:

| Field | Description |
|---|---|
| **Email** | The address you registered. It is sent as the `email` header on every call. |
| **Base URL** | Defaults to `https://api.ssllabs.com/api/v4`. Use `https://api.dev.ssllabs.com/api/v4` for the development server, which has lower limits and no availability guarantee. |

The credential test calls `/info`, so it only proves that the API is reachable. An unregistered email fails on the first assessment with *"Email is not registered with SSL Labs v4 — use the Register operation first"*.

## SSL Labs node

### Assessment → Analyze

This operation assesses a host. The **Host** field takes a bare hostname; if you paste a URL such as `https://Example.com:443/path`, it is reduced to `example.com`.

| Mode | What it does |
|---|---|
| **Wait for Result** (default) | Starts an assessment (or reuses a cached one) and polls until it is READY or ERROR, or the timeout passes. |
| **Start Only** | Starts the assessment and returns right away with its current status. Use it for long batches that you split across workflow runs. |
| **Get Status** | Makes a single call without forcing a new scan and returns the current state. Note that SSL Labs itself starts an assessment when nothing fresh enough is cached. |

**Parameters**

| Parameter | Default | Notes |
|---|---|---|
| Use Cache | on | Accept a cached report (`fromCache=on`). |
| Max Cache Age (Hours) | 24 | Only accept cached reports up to this old. `0` accepts any age. |
| Force New Scan | off | Only shown when Use Cache is off. Sends `startNew=on`. SSL Labs does not allow both flags at once, and the node rejects that combination too. |

**Options**

| Option | Default | Notes |
|---|---|---|
| Batch Concurrency | 3 | Maximum parallel assessments when there are several input items (max 10). |
| Detail Level | Summary | **Summary** returns the compact shape below. **Full** returns the raw SSL Labs `Host` object plus `reportUrl`. |
| Fail on Assessment Error | on | When off, an assessment that ends in ERROR is returned as an item instead of failing the node. |
| Ignore Certificate Mismatch | off | Continue even when the certificate does not match the hostname. |
| Initial Poll Interval (Seconds) | 5 | How often to poll while the status is `DNS` (minimum 5). |
| Poll Interval (Seconds) | 10 | How often to poll once the status is `IN_PROGRESS` (minimum 5). |
| Publish Results | **off** | ⚠️ **Published results appear on the public SSL Labs boards.** Leave this off unless you really want that. |
| Timeout (Minutes) | 15 | How long Wait for Result keeps polling before it fails. |

**Summary output** (one item per host):

```json
{
  "host": "example.com",
  "status": "READY",
  "statusMessage": "Ready",
  "grade": "B",
  "worstGrade": "B",
  "bestGrade": "A+",
  "hasWarnings": true,
  "endpoints": [
    { "ipAddress": "93.184.216.34", "serverName": "example.com", "grade": "A", "gradeTrustIgnored": "A",
      "hasWarnings": false, "isExceptional": false, "statusMessage": "Ready" }
  ],
  "certificate": {
    "subject": "CN=example.com", "issuer": "CN=R11, O=Let's Encrypt, C=US",
    "notBefore": "2026-08-27T00:00:00.000Z", "notAfter": "2026-11-26T01:00:00.000Z",
    "daysUntilExpiry": 61, "serialNumber": "04a1b2c3", "fingerprint": "…sha256…"
  },
  "testTime": "2026-09-25T23:59:50.000Z",
  "engineVersion": "2.3.1",
  "criteriaVersion": "2009q",
  "reportUrl": "https://www.ssllabs.com/ssltest/analyze.html?d=example.com"
}
```

A few details about these fields:

- `grade` is the **worst** grade across all endpoints that have one. That makes it the conservative value to alert on. Endpoints that could not be tested have no grade and are ignored.
- Grades rank from best to worst as `A+ > A > A- > B > C > D > E > F > T > M`. `T` (trust issues) and `M` (certificate name mismatch) rank below `F`.
- All timestamps are ISO-8601 strings.

**Several input items:** the node reads `/info` once, then runs at most `min(Batch Concurrency, maxAssessments − currentAssessments)` assessments at a time, and never fewer than 1. It spaces new assessments by SSL Labs' `newAssessmentCoolOff`.

- With **Continue On Fail**, a failed item becomes `{ "error": "…", "host": "…" }` and the other items keep going.
- Without it, the first failure cancels the rest of the batch.

Example: check your own hosts and alert if the grade is below A.

1. **Schedule Trigger**
2. **SSL Labs** (Assessment → Analyze, Host `{{ $json.host }}`)
3. **IF** `{{ $json.grade }}` is not `A+`/`A`
4. **Slack**

### Endpoint → Get

This operation returns the full SSL Labs `Endpoint` object for one IP address of an assessed host (`getEndpointData`). Set **Host** and **IP Address**; the IP address is listed in the `endpoints` of an Analyze result. **Use Cache** (default on) returns the cached data. This operation never starts a new assessment.

### Service

| Operation | Returns |
|---|---|
| **Get Info** | Availability, engine and criteria versions, `maxAssessments`, `currentAssessments`, `newAssessmentCoolOff`, and messages |
| **Get Status Codes** | The `statusDetails` code → English message map |
| **Get Root Certificates** | `{ trustStoreId, trustStore, certificates }` where `certificates` is the raw PEM text. Trust stores: 1 Mozilla, 2 Apple MacOS, 3 Android, 4 Java, 5 Windows. |

### Registration → Register

See [Registration](#registration).

## SSL Labs Trigger

The trigger polls SSL Labs on the schedule you set in n8n. It **never waits for a scan during a poll**: it reads cached results (`fromCache=on`, `maxAge=<Max Result Age>`) and picks up assessments that are still running on the next poll.

| Parameter | Default | Notes |
|---|---|---|
| Hosts | — | The hostnames to watch. Add one per value; comma-separated values also work. |
| Event | Grade Changed | See the table below. |
| Threshold Grade | A | For **Grade Below Threshold**. |
| Days Before Expiry | 21 | For **Certificate Expiring**. |
| Max Result Age (Hours) | 24 | Cached results up to this old are reused, so each host is re-assessed at most this often. |
| Emit Errors (option) | off | Emit an `assessmentError` item when a host's assessment ends in ERROR. |

| Event | Fires when |
|---|---|
| **Grade Changed** | A host's grade differs from the last grade seen. The output includes `previousGrade`. |
| **Grade Below Threshold** | The grade becomes worse than the threshold. It fires **once** when the grade crosses the threshold, and re-arms when the grade recovers. The output includes `previousGrade` and `thresholdGrade`. |
| **Certificate Expiring** | `daysUntilExpiry` is at or below the limit. It fires **once per certificate**, keyed on its fingerprint, and a renewed certificate re-arms it. The output includes `previousCertificate` when the certificate changed. |

Output items use the same Summary shape as the action node, plus an `event` field.

How the trigger behaves:

- **First run is a baseline.** The first result for each host is stored and nothing is emitted.
  - A certificate that is already expiring at the baseline alerts on the **next** poll.
  - A host that is already below the threshold does not alert, because it never crossed it. It alerts the next time it crosses after recovering.
  - Changing the threshold, or switching to a different event, starts a new silent baseline for that event.
- **Fetch Test Event** (manual mode) returns the current summary of each host with `event: "test"`, so you can map fields. It does not change the stored state.
- Hosts whose assessment is still running are marked as pending and checked again on the next poll.
- Days until expiry are recomputed on every poll from the certificate's `notAfter` date.
- When SSL Labs is busy (429, 503 or 529), returns a server error, or can't be reached, the poll stops quietly. The remaining hosts are checked first on the next poll. A host-specific 4xx is recorded as an error for that host.
- After a call that starts a new assessment, the trigger waits the cool-off before checking the next host.
- The stored state is versioned (`stateVersion: 1`).

## Rate limits and timing

- An assessment usually takes **1–5 minutes per IP address**, and some hosts have several. That is why **Wait for Result** can run for minutes. Raise **Timeout (Minutes)**, or use **Start Only** and later **Get Status**.
- SSL Labs limits how many assessments you may run at once (`maxAssessments`) and how quickly you may start new ones (`newAssessmentCoolOff`). The node respects both.
- How the node handles errors:

| Status | Meaning | What the node does |
|---|---|---|
| **429** | Too many assessments | Waits and retries up to 3 times |
| **503** | Maintenance | Waits a minute and retries twice, then fails with a clear message. SSL Labs recommends waiting 15–30 minutes before trying again. |
| **529** | Overloaded | Same as 503 |
| **500** | Server error | Retried once |
| **400** | Invalid parameters | Not retried |

- Prefer **Use Cache** unless you really need a fresh scan. Cached reports are fast and don't use up assessment slots.

## Compatibility

- n8n 2.x, built and tested against `n8n-workflow` 2.40
- Node.js 24
- No runtime dependencies

## Resources

- [SSL Labs API v4 documentation](https://github.com/ssllabs/ssllabs-scan/blob/master/ssllabs-api-docs-v4.md)
- [SSL Labs API v4 announcement](https://notifications.qualys.com/api/2023/09/28/introduction-of-api-v4-for-qualys-ssllabs-and-deprecation-of-api-v3)
- [SSL Labs Server Test](https://www.ssllabs.com/ssltest/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE)
