# GreenMesh AI Chat — a phone that is also an AI node

An Android app that runs small language models **on the phone itself** (llama.cpp
via llama.rn) and turns each phone into an **OpenAI-compatible server** on your
LAN. Point any OpenAI client at `http://<phone-ip>:8080/v1` — or chain several
phones into a mesh where one of them plans a job, splits it into steps, and farms
the steps out to the others.

- **On-device inference** — pick a GGUF, load it on the CPU, chat offline. No
  cloud, no account, nothing leaves the phone.
- **Photos (vision)** — attach an image and the local vision model reads it
  (mmproj projector; Qwen-VL / InternVL / Gemma 3 families).
- **Serve the model** — the phone exposes `/v1/models`, `/v1/chat/completions`
  (with SSE streaming) and `/health`, so Ollama-style clients, scripts and other
  phones can use it.
- **Mesh** — the Router tab discovers every OpenAI-compatible server on the Wi-Fi
  (this app, Ollama, LM Studio, llama.cpp, vLLM…), tests each one with a real
  completion, and adds the ones that answer as workers.
- **Planner mode** — the phone's own model decomposes a request into steps, sends
  each step to a worker **with a system prompt that tells it it is one node of a
  mesh** (goal, its step, the results it depends on), then merges the partial
  answers.
- **Tools for the model** — the coordinator model can call tools by itself:
  `scan_mesh`, `list_workers`, `add_worker`, `remove_worker`, `test_worker`,
  `route_job`, `plan_job`, `set_policy`, `set_planner`.
- **Remote control API** — everything above is also exposed over HTTP
  (`/v1/mesh/*`), so a planner can live on a laptop, another phone or any script.
- **Dictation** — tap the Mic button in a chat to start, tap again to stop, or
  hold it to talk. The transcript lands in the message box (or sends itself, if
  you switch that on). The first tap downloads a speech model (57 MB) by itself;
  after that transcription runs entirely on the phone with Whisper - no audio
  leaves the device. Settings lets you pick a bigger model (31 MB tiny through
  181 MB small), choose the spoken language, and decide whether a transcript
  should send automatically.
- **Chat import / export** — JSON Lines (one chat per line, OpenAI-style
  messages), the format ChatGPT exports and fine-tuning tools read. Markdown is
  available for reading, and import also takes a JSON array of chats, a bare
  `messages` array and ChatGPT's `conversations.json`. Nothing is duplicated on
  re-import.
- **Built to keep serving** — a foreground service holds a wake lock, so Android
  doze does not drop the node off the network mid-job. Verified with the screen
  off: `/health` kept answering and the `greenmesh:serving` partial wake lock stayed
  held.

| Chats | Model | Router |
|---|---|---|

## Install

Download `app-release.apk` from the Releases page and open it on the phone
("install unknown apps" must be allowed). The APK ships no models: download one
from the Model tab (or sideload a `.gguf` into the app's folder).

> The published APK is signed with the project's release key. If you build your
> own, either generate a keystore (see below) or accept the debug key — which
> must never be used for a public release.

## Build from source

Requirements: Node 18+, JDK 17, Android SDK, and a device or emulator.

```bash
npm install
cd android
JAVA_HOME="/path/to/jdk-17" \
ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" \
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

Before publishing anything, also create `android/keystore.properties`
(git-ignored):

```properties
storeFile=/absolute/path/to/release.keystore
storePassword=…
keyAlias=…
keyPassword=…
```

The build picks it up automatically; without it, release builds fall back to the
debug key.

## Models

The Model tab lists presets with exact sizes. Sizes matter: a vision model needs
its `mmproj` projector too.

| Preset | Download | Needs |
|---|---|---|
| InternVL3 1B (photos) | 0.63 GB + 0.31 GB projector | ~2.5 GB free RAM |
| Qwen3-VL 2B (photos) | 1.03 GB + 0.41 GB | ~3 GB |
| Qwen2-VL 2B (photos) | 0.92 GB + 0.66 GB | ~3 GB |
| Qwen2.5-VL 3B (photos) | 1.76 GB + 0.77 GB | ~4.5 GB |
| Qwen3-VL 4B (photos) | 2.27 GB + 0.41 GB | ~6 GB |
| Qwen2.5-VL 7B (photos) | 4.36 GB + 0.78 GB | ~8 GB |
| Qwen3 0.6B (text) | 0.36 GB | runs anywhere |
| LFM2.5 1.2B (text) | 0.71 GB | low-RAM phones |
| Qwen3 1.7B (text) | 1.03 GB | ~2 GB |
| Qwen3 4B (text) | 2.27 GB | ~4 GB |
| Nemotron Nano 4B v1.1 (text) | 2.53 GB | ~4.5 GB |
| Nemotron Mini 4B (text) | 2.45 GB | ~4.5 GB |

**Gemma 3n (E2B/E4B) is deliberately absent from the photo list**: llama.cpp
implements the architecture but ships no vision projector for it, so photos are
impossible there regardless of size.

Each model keeps its own license — see THIRD_PARTY.md.

## Remote control API

Base URL is the same as the model endpoint (`http://<phone-ip>:8080`). Every
install starts with the shared key `greenmesh-mesh-default` (see `src/config.js`), so
requests send `Authorization: Bearer <key>`. Change it on the Server tab (or
remotely via `POST /v1/mesh/params {"apiKey":"…"}`) and use the same value on
every node you want in your mesh. Nothing here executes arbitrary code or reaches
outside the LAN.

A node is built to run unattended, so everything about it is drivable from the
network:

- **Self-healing.** `POST /v1/mesh/node/restart` kills and relaunches the app; the
  server and the last model come back on their own. `/v1/mesh/node/awake` re-asserts
  the foreground service without a restart. The app also re-arms itself on boot and
  after an app update (`BootReceiver`), and a watchdog re-starts the listener if it
  ever goes down.
- **Thermal guard.** `/v1/mesh/device` reports thermal status, battery temperature
  and charge. Above the thresholds the node stops accepting completions and answers
  `503 cooling down`, and `/health` says so - a planner can route around a hot phone
  instead of cooking it. `/v1/mesh/thermal` turns the guard off.
- **Keep-alive.** The Wi-Fi lock is held while serving, but the CPU wake lock is
  taken *only while a job is in flight*, so an idle node stays cool and charged.
  A repeating native alarm wakes the app every couple of minutes and re-asserts
  the service and the listener, so a node heals itself even if Android froze it.
  On boot and after an app update a headless JS task brings the server and the
  last model up with no UI at all.
  `/v1/mesh/keepalive {"ask":"battery"}` asks Android to stop optimising this app;
  `{"ask":"autostart"}` opens the vendor screen (MIUI kills background apps unless
  whitelisted). Both need one human tap per phone.

**What one human tap per phone buys you** (all three reachable remotely with
`POST /v1/mesh/keepalive {"ask":"battery"|"autostart"|"overlay"}`):
battery-optimisation exemption, the vendor autostart whitelist (MIUI blocks even
`MY_PACKAGE_REPLACED` without it: *"process is not permitted to auto start"*), and
"display over other apps", which is what lets the health-check alarm restart the
service on an idle phone (Android 12+ otherwise refuses a background
`startForegroundService`).

**What no app can survive:** a user "Force stop" (or a vendor cleaner) puts the app
in Android's *stopped* state, and the system then delivers no broadcasts at all -
the node stays down until someone opens it. Prefer `POST /v1/mesh/node/restart`
(soft) for remote recovery.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | liveness + model, vision, ctx, in-flight |
| GET | `/v1/models` | loaded model id |
| POST | `/v1/chat/completions` | OpenAI chat (stream on/off; routed in coordinator mode) |
| GET | `/v1/mesh/status` | node, model, params, server + router state |
| GET | `/v1/mesh/nodes` | workers in the mesh (peer keys redacted) |
| POST | `/v1/mesh/scan` | `{deep?}` sweep the Wi-Fi, add verified servers |
| POST | `/v1/mesh/nodes` | `{ip,port?,key?}` test and add one worker |
| DELETE | `/v1/mesh/nodes` | `{id\|ip}` drop a worker |
| GET | `/v1/mesh/params` | current on-device + server parameters |
| POST | `/v1/mesh/params` | `{nCtx,nThreads,temperature,maxTokens,topP,systemPrompt,port,apiKey}` |
| POST | `/v1/mesh/model/load` | `{name?}` load a downloaded model |
| POST | `/v1/mesh/model/unload` | free the model |
| POST | `/v1/mesh/model/reload` | reload the current model with current params |
| POST | `/v1/mesh/server/start` \| `/stop` \| `/restart` | listener lifecycle (`{port?}` for restart) |
| GET | `/v1/mesh/device` | thermals, battery, paused state, keep-alive status |
| POST | `/v1/mesh/node/restart` \| `/awake` | relaunch the app \| re-assert the service |
| POST | `/v1/mesh/thermal` | `{enabled}` thermal guard on/off |
| POST | `/v1/mesh/keepalive` | `{ask:"battery"\|"autostart"\|"overlay"}` open the OS screens |
| GET | `/v1/mesh/chats` | chat list (id, title, message count) |
| POST | `/v1/mesh/chats/export` | `{format:jsonl\|md\|json}` → `{name, content}` |
| POST | `/v1/mesh/chats/import` | `{content}` merge chats in (dedupes) |
| GET | `/v1/mesh/dictation` | Whisper model state, installed models, presets |
| POST | `/v1/mesh/dictation/model` | `{preset\|name}` install and load a Whisper model |
| POST | `/v1/mesh/dictation/transcribe` | `{path}` transcribe a 16 kHz mono WAV on the phone |
| POST | `/v1/mesh/dictation/pcm` | `{pcm}` transcribe base64 16-bit PCM (mono, 16 kHz) |
| GET | `/v1/mesh/log` | recent request log |
| GET | `/v1/mesh/tools` | tools the coordinator model may call |
| POST | `/v1/mesh/policy` | `{policy}`: local-first, least-busy, round-robin, model-match, smart |
| POST | `/v1/mesh/planner` | `{on}` planner mode |
| POST | `/v1/mesh/plan` | `{goal,format?}` plan → dispatch steps → merge |
| POST | `/v1/mesh/agent` | `{instruction}` the model picks tools, returns the trace |
| POST | `/v1/mesh/jobs` | `{prompts[]}` fan a batch over the workers |

Examples:

```bash
# what is this node doing?
curl -s http://<phone-ip>:8080/v1/mesh/status | jq

# change sampling + context (reloads the model because n_ctx changed)
curl -s -X POST http://<phone-ip>:8080/v1/mesh/params \
  -H 'Content-Type: application/json' \
  -d '{"nCtx":4096,"temperature":0.6,"maxTokens":256}'

# free and reload the model
curl -s -X POST http://<phone-ip>:8080/v1/mesh/model/unload
curl -s -X POST http://<phone-ip>:8080/v1/mesh/model/reload

# find workers and plan a job across them
curl -s -X POST http://<phone-ip>:8080/v1/mesh/scan -d '{"deep":true}'
curl -s -X POST http://<phone-ip>:8080/v1/mesh/plan \
  -H 'Content-Type: application/json' \
  -d '{"goal":"Compare solar and wind for a small house in Poland"}'

# let the phone's own model decide what to do
curl -s -X POST http://<phone-ip>:8080/v1/mesh/agent \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"Find every AI server on this Wi-Fi and report what they run"}'
```

A planner that forwards work to this node should send the header
`x-greenmesh-hops: 1` so the request is executed locally instead of re-routed
(that guard prevents two coordinators bouncing the same job forever).

## Keeping a node alive

- The foreground service holds a partial wake lock + Wi-Fi lock; the node stays
  reachable with the screen off.
- Swiping the app away does **not** stop the service (`stopWithTask="false"`), and
  the service is `START_STICKY` so Android can bring it back after a low-memory
  kill.
- Honest limits: a user "Force stop" (or MIUI's cleaner) kills it — no app can
  survive that. Autostart and "no battery restrictions" must be granted by the
  user: *Settings → Apps → GreenMesh AI Chat → Autostart*, and battery saver →
  "No restrictions". Without those, a Xiaomi/Redmi device may freeze the node
  overnight.

## Privacy

- Conversations, settings, model parameters and API keys live in the app's private
  storage on the phone (`AsyncStorage`). The API key is **not** encrypted — that
  is stated in the app itself.
- Nothing is sent anywhere unless you configure an API endpoint or point the app
  at a remote server. There is no telemetry, no analytics, no account.
- The app binds a TCP listener on your LAN only; the port is reachable by anyone on
  that network, so set a required API key on the Server tab if the Wi-Fi is shared.

## Known limits

- One llama context per phone means one generation at a time per node;
  parallelism comes from adding phones, not from splitting a single answer.
- Deep scans cover the /24 (254 addresses × 6 ports) and take a couple of minutes.
- The mesh has been exercised with one phone and one PC server; behaviour at
  3+ physical phones is untested.
- Vision needs the projector file; text-only models reject images with a clear
  error rather than silently ignoring them.

## Roadmap

- Auto-load the last model on launch (today the server auto-starts, the model does
  not).
- Multi-slot decoding per node (llama.rn supports slots) to serve several requests
  at once from one phone.
- Overnight soak testing for the wake-lock path.
- iOS port (llama.rn supports it; the TCP server layer would need a rewrite).

## License

MIT — see LICENSE. Third-party components and models: THIRD_PARTY.md.
