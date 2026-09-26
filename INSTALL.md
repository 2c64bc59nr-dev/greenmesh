# GreenMesh — install and first run

For testers. Nothing here sends your audio, photos or chats anywhere: the models
run on the phone, and the only network traffic is whatever you point the app at.

## Install

1. Copy `GreenMesh-<version>-arm64.apk` to the phone.
2. Open it. Android will say the file came from outside the store — allow
   "Install unknown apps" for whichever app you opened it from (Files, Chrome…).
3. If Play Protect warns, choose **Install anyway**. The APK is signed with a
   local key, not a store key.

Requirements: Android 8 or newer, and ideally 4 GB of RAM or more for the bigger
models. An arm64 device (every phone from the last several years).

## First run

The app opens on **Chats**. Two things happen by themselves on first launch:

- it starts an OpenAI-compatible server on port 8080 and posts an ongoing
  notification ("GreenMesh node") so Android does not put it to sleep;
- it asks for notification permission — allowing it is what keeps that
  notification (and the node) alive.

Then, to actually chat with a model:

1. **Model** tab → pick a small model (Qwen3 0.6B is the quickest to try,
   ~380 MB) → **Download**, then **Load**.
2. Back on **Chats** → **+ New chat** → type. Or tap **Mic** to dictate: tap once
   to start and again to stop, or hold it to talk. The first tap downloads a
   speech model (~57 MB) and then transcribes on the phone.

Prefer no downloads? **Settings → Connection** accepts any OpenAI-compatible
endpoint (OpenAI itself, Ollama or LM Studio on your home PC) — paste the URL and
key and switch the chip at the top of a chat to **API**.

## Two phones in a mesh

Install on a second phone, put both on the same Wi-Fi, and they find each other:

1. On phone A: **Router** tab → turn the coordinator on.
2. **Router → Scan** — it sweeps the Wi-Fi and adds any OpenAI-compatible server
   it finds, including phone B, after a health check.
3. **Plan a job across the mesh** — type a goal. Phone A splits it into steps and
   the workers execute them; A merges the answers.

Buses: every install starts with the shared key `greenmesh-mesh-default` so the
phones trust each other out of the box. If your Wi-Fi is not yours alone, change
it on **Server → Required API key** on every phone.

## Making a phone a reliable worker (optional)

A phone that must answer jobs while its screen is off needs three taps, once per
phone, all reachable from **Settings**:

- **battery: unrestricted** — stop Android freezing the app when idle;
- **autostart** — the vendor's whitelist screen (Xiaomi/Redmi kills background
  apps without it);
- **background start** — "display over other apps", which is the exemption that
  lets the health check restart the service on a sleeping phone.

After that the node survives reboots, app updates and a killed listener on its
own. A *Force stop* still wins — that is Android, not the app.

## Things worth trying as a tester

- Ask the same question on **On-device** and **API** and compare speed/quality.
- Attach a **Photo** and ask what is in it (needs a vision model loaded).
- **Chats → Export .jsonl**, then **Import** that file back: it should say
  "0 imported, N already present" rather than duplicating anything.
- **Settings → Diagnostics** switches the event log on: it shows every model
  load, download, dictation and mesh call this phone makes.
- **Settings → Speech**: the phone's own voice reads replies aloud; Piper voices
  can be downloaded too (see the note in Settings about the on-device voice
  engine status in this build).

## Reporting a problem

**Settings → Diagnostics → Copy** the event log, and say which phone, which tab
and what you expected. That log is designed to make a bug reproducible without
guessing.

## Verify your download (optional but recommended)

This APK is signed with GreenMesh's own key. Its certificate fingerprint is:

```
SHA-256  f718cd77af19b71acd5cd404273d74e9858c8bbbedd529b1c3879d54a5f6bc7b
```

To check the file you downloaded is the one published here:

```bash
apksigner verify --print-certs GreenMesh-1.2.0-arm64.apk
```

The `Signer #1 certificate SHA-256 digest` must match the value above. If it does
not, the file did not come from this project - do not install it.

## Uninstalling

Uninstall like any app. Downloaded models live in the app's private storage and
go with it; nothing is left on the SD card.
