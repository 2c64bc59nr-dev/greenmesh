# Third-party components and model licenses

This project is MIT-licensed (see LICENSE). It relies on third-party software and
can download third-party AI models. Nothing model-related is bundled: every model
file is downloaded by the user, onto their own device, after they accept the
license shown by the model's publisher.

## Bundled libraries

| Component | License | Notes |
|---|---|---|
| [llama.rn](https://github.com/mybigday/llama.rn) | MIT | React Native bindings around llama.cpp |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | inference engine + `mtmd` multimodal projector support |
| [React Native](https://github.com/facebook/react-native) | MIT | app runtime |
| [Expo](https://github.com/expo/expo) (expo, expo-asset, expo-clipboard, expo-file-system, expo-image-picker, expo-network) | MIT | native modules |
| [react-native-tcp-socket](https://github.com/Rapsssito/react-native-tcp-socket) | MIT | the in-app HTTP server |
| [Redux Toolkit](https://github.com/reduxjs/redux-toolkit), [React Redux](https://github.com/reduxjs/react-redux), [redux-persist](https://github.com/rt2zz/redux-persist) | MIT | state management + persistence |
| [axios](https://github.com/axios/axios) | MIT | HTTP client for OpenAI-compatible endpoints |
| [@react-native-async-storage/async-storage](https://github.com/react-native-async-storage/async-storage) | MIT | local storage |
| [whisper.rn](https://github.com/mybigday/whisper.rn) | MIT | on-device speech recognition bindings |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | transcription engine, and the source of the GGML speech models |
| [@fugood/react-native-audio-pcm-stream](https://github.com/fugood/react-native-audio-pcm-stream) | MIT | raw PCM microphone capture for dictation |
| [expo-speech](https://github.com/expo/expo), [expo-av](https://github.com/expo/expo) | MIT | speech synthesis and audio playback |
| [expo-sharing](https://github.com/expo/expo), [expo-document-picker](https://github.com/expo/expo) | MIT | chat export/import through the system share sheet and file picker |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [react-native-sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | on-device TTS engine (VITS/Piper) - see the note below |

### Speech models the app can download

Whisper GGML models come from `ggerganov/whisper.cpp` (MIT). Piper voices come
from `rhasspy/piper-voices`, and **each voice carries its own license**, stated in
that voice's `MODEL_CARD` - most are MIT, but some are CC-BY, CC-BY-SA or
non-commercial. Before redistributing a voice, or shipping one inside an app,
read that voice's card. The voices the app offers by name are:

`en_US-lessac-medium`, `en_US-amy-medium`, `en_GB-alba-medium`,
`en_US-ryan-medium`, `pl_PL-darkman-medium`, `pl_PL-gosia-medium`.

The sherpa-onnx VITS engine is bundled so that downloaded voices can be
synthesised on the phone. In the current build it is loaded lazily and reports
itself as unavailable if the native module cannot initialise, rather than
crashing; speech falls back to the platform's own synthesiser.

## Models the app can download (publisher's license applies)

| Model | Publisher / license | Notes |
|---|---|---|
| Qwen3-VL 2B / 4B | Alibaba Qwen — Apache-2.0 | vision (photos) |
| Qwen2.5-VL 3B / 7B | Alibaba Qwen — Apache-2.0 (see model card) | vision (photos) |
| Qwen2-VL 2B | Alibaba Qwen — Apache-2.0 | vision (photos) |
| InternVL3 1B | OpenGVLab — Apache-2.0 / MIT (see model card) | smallest vision option |
| Qwen3 0.6B / 1.7B / 4B | Alibaba Qwen — Apache-2.0 | text |
| LFM2.5 1.2B Instruct | Liquid AI — Liquid AI Community License | text |
| Llama-3.1-Nemotron-Nano-4B-v1.1 | NVIDIA — NVIDIA Open Model License + Llama 3.1 Community License | text |
| Nemotron-Mini-4B-Instruct | NVIDIA — NVIDIA Open Model License | text |

Before publishing or distributing an app that ships or recommends these models,
re-read each publisher's current license: some (notably NVIDIA and Liquid) add
use restrictions beyond Apache-2.0, and Gemma-family models (deliberately not
listed for photos here, because upstream llama.cpp has no vision projector for
Gemma 3n) require accepting Google's Gemma Terms of Use.

## Trademarks

"OpenAI", "Qwen", "Llama", "NVIDIA", "Gemma" and other names are trademarks of
their respective owners. This project is not affiliated with, endorsed by, or
sponsored by any of them; the OpenAI-compatible API is implemented from the
publicly documented request/response shape.

### Build-time and development dependencies

The published source tree also pulls in build tooling (the Expo/React Native CLI and
its transitive dependencies). These are used to build the app and are **not
distributed** in the APK. Their licences do not place obligations on this project's
distribution, and where a package is dual-licensed the permissive option is taken
(for example `node-forge`, offered as `BSD-3-Clause OR GPL-2.0`, is used under
BSD-3-Clause). Materially copyleft licences (GPL, AGPL) do not appear in either the
shipped or the build-time set; the only MPL-2.0 packages present are build tooling,
whose file-level copyleft does not extend to this source tree.
