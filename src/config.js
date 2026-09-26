/**
 * Build-time defaults.
 *
 * DEFAULT_API_KEY is what a fresh install uses as the required key for its own
 * OpenAI-compatible server, and what it presents when talking to other nodes in
 * the mesh. A shared default is what makes "install the app on five phones and
 * they just work" possible - and it is also why you should change it if your
 * Wi-Fi is not yours alone: the value is public in the source.
 *
 * Change it in the app (Server tab -> Required API key) or remotely:
 *   curl -X POST http://<phone>:8080/v1/mesh/params -d '{"apiKey":"my-secret"}'
 */
export const DEFAULT_API_KEY = "greenmesh-mesh-default";

/** Shown in the UI next to the key field. */
export const DEFAULT_API_KEY_HINT =
  "Default value shared by every install so phones find each other. Change it on all your nodes if the Wi-Fi is shared.";

export default { DEFAULT_API_KEY, DEFAULT_API_KEY_HINT };
