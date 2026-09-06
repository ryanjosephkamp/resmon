# Local transcription feasibility — Delegation 10

Status: measurement in progress; this report does not decide whether phase 2.0b ships voice.
Baseline: `d4ff2c5b2e99e943d09b9fe4eb0d5b044d96b884` (current upstream main, v2.0.0),
six commits after the brief's `adf54f4`. The four runner labels and standalone
CPython pin remain unchanged. Only this report, the new voice workflow and the probe
script are changed. No production dependency, endpoint, renderer, Electron source,
entitlement or release configuration is changed.

## Q1 — candidate and wheel availability

The spike selects **pywhispercpp**, using **1.5.1** on macOS ARM64, Windows x64 and
Linux x64; **1.2.0** on macOS Intel. This is a version split, not one universally
available release. PyPI's current 1.5.1 wheel set has no CPython 3.11 Intel macOS
wheel. The old 1.2.0 Windows wheel imports `whisper.dll` but contains no such DLL;
it was inspected, not executed. It is not the Windows candidate in the workflow.

[1.5.1 metadata](https://pypi.org/pypi/pywhispercpp/1.5.1/json),
[1.2.0 metadata](https://pypi.org/pypi/pywhispercpp/1.2.0/json), and
[upstream binding documentation](https://github.com/absadiki/pywhispercpp/tree/f7bf62118c0a33a43cf8aabb58eef16cea5d16c4)
are the availability sources. Actual packaged execution is the separate Q2 gate.

Other candidates, inspected on 2026-09-06:

| Candidate | Established availability | Execution scope |
| --- | --- | --- |
| faster-whisper 1.2.1 / CTranslate2 4.8.2 | Pure Python wrapper; CTranslate2 has cp311 wheels for all four targets. Adds PyAV, ONNX Runtime, tokenizers and Hugging Face dependencies. | Not installed or transcribed in this spike; full dependency closure remains untested. |
| whispercpp 0.0.17 | cp311 wheels for Intel macOS and Linux x64; no matching Windows or ARM macOS wheel in this release. | Metadata only. |
| vosk 0.3.45 | Wheels for Windows and Linux; no macOS wheel in this release. Older Vosk releases may differ. | Metadata only; not a claim that Vosk cannot support macOS. |

Sources: [faster-whisper metadata](https://pypi.org/pypi/faster-whisper/1.2.1/json),
[CTranslate2 metadata](https://pypi.org/pypi/ctranslate2/4.8.2/json),
[CTranslate2 requirements](https://opennmt.net/CTranslate2/installation.html),
[whispercpp metadata](https://pypi.org/pypi/whispercpp/0.0.17/json),
[Vosk metadata](https://pypi.org/pypi/vosk/0.3.45/json).

## Q2 / P1–P3 — packaged execution

The workflow builds a baseline installer, installs only hash-pinned wheels into
`prepare-backend.js`'s CPython **3.11.16**, python-build-standalone **20260814**,
and rebuilds using the unchanged release configuration with `--publish never`.
All staging, downloads, extracted installers and evidence live under runner temp.

The positive probe requires `app.asar`, the actual packaged interpreter and runtime
marker, isolated mode, package containment, committed wheel/member hashes, and
hash-verified model/audio inputs. It runs from a read-only DMG, extracted AppImage,
or silent NSIS installation. A staging-only import does not pass. The negative
probe copies that runtime, corrupts its Python extension, and requires exit 1 and
an `ImportError` from the native import; the original binary must remain unchanged.
Evidence is uploaded even if a job fails; no installer is published or uploaded.

Current CI verdict: **0 of 4 established pending native runner receipts**.
Local ARM Mac: read-only DMG transcription and the broken-binary control passed.
The first local build produced 0/22 word edits, with a 0.10 maximum word-error rate.
This familiar English fixture establishes a functional smoke test, not scientific
recognition quality, accents, languages, noisy speech or scholarly terminology.

## Q3 — model weights and fixture

The probe bundles `ggml-tiny.en.bin` **at build time**. It downloads nothing during
transcription; Python socket connect/bind/DNS events are rejected. This is a probe
packaging choice, not a decision about a future production model manager.

- Model: **77,704,715 bytes**, SHA-256
  `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`.
  [Pinned model revision](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1).
- Fixture: **352,078 bytes**, 16 kHz mono 16-bit PCM, **11 seconds**, SHA-256
  `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`.
  [Pinned upstream JFK sample](https://github.com/ggml-org/whisper.cpp/blob/a8d002cfd879315632a579e73f0148d06959de36/samples/jfk.wav).
- Weights: MIT according to the model card and
  [OpenAI Whisper license](https://github.com/openai/whisper/blob/v20250625/LICENSE).
- Reference is the 22-word JFK sentence beginning “And so my fellow Americans”.
  WER uses word-level Levenshtein distance, lowercases and strips punctuation;
  it does not stem words or silently discard substitutions.

First-use storage would move the 77,704,715-byte weight download to a state directory
and require an explicit download/error/retry/integrity lifecycle. That lifecycle is
not implemented or tested here. The fixture is a test asset, not required by a future app.

## Q4 — measured size and timing

First local paired unsigned ARM64 DMGs (before supplemental notice collection):
baseline **221,373,066 bytes**, probe **311,266,546 bytes**, delta **89,893,480 bytes**.
Direct read-only-DMG invocation: imports/model load **9.279851 s**, transcription
**0.158487 s**, total probe **9.509396 s**, four threads, CPU mode. Timing includes
no microphone capture, renderer transport or endpoint. Measurements include host
cache state and a single paired build's compression nondeterminism; wheel size is
not being substituted for installer growth. Final native CI numbers are pending.

## Q5 — microphone capture on this Mac

Host: macOS **26.3.1 (a)**, build **25D771280a**, ARM64. A throwaway Electron
**41.10.6** app was built outside both checkouts, with a distinct bundle ID and
profile. No resmon backend ran and no listening socket was created by its code.
It opens an audio track for one second, inspects 2,048 samples in memory, stops the
track and closes the AudioContext. It saves metadata only, not audio.

- Removing the main executable's signature entirely caused Launch Services to
  reject launch: `RBSRequestErrorDomain Code=5`, nested POSIX error 163.
  This establishes failure of that copy on this host, not a universal unsigned-app rule.
- Ad-hoc signing with `codesign --force --deep --sign -` allowed launch. This is
  **no Developer ID / no notarization**, but it is not “no signature”.
- With the usage string and audio-input entitlement, macOS permission was granted.
  A corrected Electron handler allowed `getUserMedia({audio:true, video:false})`;
  track state `live`, 48,000 Hz, mono, 2,048/2,048 nonzero samples. No audio saved.
- The first handler rejected the percent-encoded file URL and returned
  `NotAllowedError` despite macOS permission being granted. The correction used
  `pathToFileURL(...).href` and matched `details.embeddingOrigin` for permission
  checks and `details.requestingUrl` for requests. This illustrates that OS and
  Electron permissions are independent gates.

The existing release lacks `com.apple.security.device.audio-input`,
`NSMicrophoneUsageDescription`, and explicit media permission handlers. The
throwaway app added these; production files are unchanged. A future implementation
must scope both permission handlers to its trusted renderer and audio only, reject
camera/other origins, ask on an explicit user action, and handle denial/restart.
The file-URL test is narrower than resmon's loopback renderer and hardened-runtime
release signing; those integrations are not established.

Sources: [Apple audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input),
[Apple usage description](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSMicrophoneUsageDescription),
[Electron media access](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos),
[Electron permission handlers](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler).

## Q6 — licenses and notices

The probe extracts wheel-shipped license texts verbatim into its evidence and
probe payload. Native inventories identify every added binary's original wheel,
member path, exact byte count and SHA-256; these are compared after installation.
Supplemental upstream notices and a durable verbatim appendix are being collected.
The pywhispercpp wheels contain the wrapper MIT license, but not all native
third-party notices. In particular the Windows wheel includes Microsoft runtime
DLLs and the Linux wheel includes libgomp. A working loader is not license clearance.
The final report will preserve the remaining notice/provenance limits explicitly.

## Fallback cost and remaining limits

If an installer target fails, retaining typed input adds no transcription dependency,
model storage or metered cost. A hosted alternative adds credentials, network/audio
transfer and provider billing; no provider or price is selected here. Another local
engine adds a separate model format, dependency/license closure and another native
installer experiment. These are implementation consequences, not time estimates.

This spike does not establish continuous recording, streaming latency, VAD, cancellation,
energy use, memory ceilings, user-speech accuracy, minimum OS support, clean consumer
machines, signed/notarized deployment or a production assistant integration. Intel's
older binding adds an independent maintenance/version burden. No phase decision is made.
