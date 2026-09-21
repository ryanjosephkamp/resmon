# The webhook receiver contract

resmon can deliver a routine's report to an HTTPS endpoint you own. This page is
what you need to write the thing on the other end. It documents behaviour that
shipped with schema 21's second delivery PR; the channel itself, and the record
behind it, are described in the README's *Delivery: where a report goes, and
whether it got there*.

resmon is a desktop application on your machine. It makes an outbound POST and
opens nothing to the network; a receiver on the same machine is the ordinary
case, and a receiver elsewhere works only because something you run — a tunnel,
a reverse proxy — is already reachable from it.

## What arrives

One `POST` per delivered run, with `Content-Type: application/json`, a
`User-Agent` of `resmon`, and two headers of ours:

| Header | Value |
|---|---|
| `X-Resmon-Delivery` | the delivery's id in this corpus, stable across retries |
| `X-Resmon-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **exact request body**, keyed with this destination's shared secret |

The body:

```json
{
  "envelope_version": 1,
  "delivery_id": 41,
  "routine": {"id": 3, "name": "Diffusion watch"},
  "execution_id": 128,
  "status": "completed",
  "started_at": "2026-09-21T08:00:03",
  "completed_at": "2026-09-21T08:04:11",
  "result_count": 22,
  "new_result_count": 4,
  "coverage_summary": "3 selected sources: 3 answered, 0 recorded non-answer (could not answer), 0 unknown.",
  "report_sha256": "…",
  "search_record_url": "https://your-resmon.example/api/executions/128/search-record?format=json",
  "bundle_url": "https://your-resmon.example/api/deliveries/41/bundle?exp=1758556800&sig=…",
  "bundle_expires_at": "2026-09-22T08:04:12+00:00"
}
```

`coverage_summary` is resmon's read-time account of which of the run's sources
answered, drawn from saved facts — the same sentence the app shows. It is `null`
when resmon could not build one.

`search_record_url` and `bundle_url` are built from the `delivery_base_url`
setting when you have set one, and from `http://127.0.0.1:<the port resmon is
serving on>` when you have not. `search_record_url` needs resmon's local API
token; `bundle_url` does not, and is the only route in resmon that does not.

When the destination has *Send the bundle inside the envelope* ticked, the
envelope carries `bundle_base64`, `bundle_sha256` and `bundle_bytes` instead of
`bundle_url` and `bundle_expires_at`, both of which are then `null`.

## Checking the signature

Three lines, in any language with an HMAC:

1. read the **raw request body as bytes**, before any JSON parsing;
2. compute `HMAC-SHA256(secret, body)` and hex-encode it;
3. compare it to `X-Resmon-Signature` minus its `sha256=` prefix, with a
   constant-time comparison, and refuse the request if it does not match.

Python, whole:

```python
import hashlib, hmac
expected = "sha256=" + hmac.new(SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(expected, request.headers.get("X-Resmon-Signature", "")):
    return 401
```

The secret is yours and resmon's. You set it on the destination in the routine's
Delivery list; resmon puts it in the operating system's keyring under
`webhook_secret_<destination id>` and never writes it to a database, a settings
file or a log. A destination with no secret saved is never sent to: resmon signs
every envelope and has no unsigned fallback.

## Fetching the bundle

`GET` the `bundle_url` exactly as given. It answers `application/zip` — the same
export bundle the app's Results screen produces, with the report, the log, the
metadata, the LaTeX/PDF bundle and the search-record companions.

The link is signed for one delivery and expires 24 hours after the envelope was
sent. A wrong signature, an expired one and a delivery that was not a webhook
all get the same `403` with `{"detail": {"reason": "signature_invalid", …}}`, so
a caller guessing learns only that it did not work.

The bundle is **rebuilt when you fetch it**, which is why the linked form carries
no `bundle_sha256`: a zip carries its own timestamps and is not byte-identical
from one build to the next. What identifies the contents is `report_sha256`,
which is the hash of the report file itself and is stable. Hash the report inside
the zip and compare it to that.

## Answering

Answer `2xx` once you have taken responsibility for the envelope. Anything else,
and any answer that takes longer than **20 seconds**, is a failure: resmon
records it, waits 1 minute, then 5, then 25, and stops after three attempts with
the reason on the row, where the user sees it under *Where did this go?*. Press
Retry there and the attempt counter starts again.

Work implied by the envelope — fetching the bundle, rendering something, sending
it on — belongs after your `2xx`, not before it. resmon retries a slow receiver
and a receiver that does not answer identically, so a receiver that does its work
inside the request can be sent the same run twice.

`X-Resmon-Delivery` is the idempotency key. It is the same across all three
attempts at one delivery and unique per (run, destination), so a receiver that
records it can recognise a repeat.

## What resmon records, and what it does not

A failure is recorded with the HTTP status code, or with the class of the
transport error and the timeout resmon waited. **The URL is never written to the
record**, because `deliveries.last_error` is read back through resmon's MCP tool
surface and where a person sends their research is theirs. The destination is
identified by its row id, which the app resolves locally.

What resmon claims is what it did: that your receiver answered `2xx`. What you
do with the envelope afterwards it cannot see, and it does not say.
