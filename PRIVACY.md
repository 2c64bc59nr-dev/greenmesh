# Privacy

GreenMesh runs AI models on your phone. It has no analytics, no telemetry, no
accounts, and no server run by the project. Nothing about you or your conversations
is sent anywhere unless you configure an endpoint yourself.

## What the app accesses, and when

- **Microphone** (`RECORD_AUDIO`) - only while you hold the dictation button or start
  a dictation session. Audio is transcribed on the device and the recording is
  discarded. Nothing is uploaded.
- **Photos and media** - only the file you choose when you attach one to a message,
  passed to the model you loaded. If you send it to a remote endpoint instead of an
  on-device model, that is your choice and that endpoint's terms apply.
- **Network** - to download models you request from their publishers (Hugging Face),
  to reach any endpoint you configure, and to run the local server described below.
- **Notifications** - to keep the worker node running in the background.

## Conversations and files

Conversations, settings and downloaded models are stored in the app's private
storage. Uninstalling the app removes them. Chat export writes a file only when you
ask it to, to a location you pick.

## The local server

When the node is running, the app listens on port 8080 of your local network so that
other machines you own can send it jobs. It is not reachable from the internet
unless you forward the port yourself. Requests must present the API key shown on the
Server tab; every fresh install starts with a shared default key so that phones find
each other quickly, and you should change it if your network is not exclusively
yours.

## Models and third parties

No model is bundled. Every model is downloaded by you, from its publisher, onto your
device, and its own licence and privacy terms apply to it (see `THIRD_PARTY.md`).

## Children, and changes

The app is a developer tool, not directed at children. If this policy changes, the
change appears in this file in the repository's history.
