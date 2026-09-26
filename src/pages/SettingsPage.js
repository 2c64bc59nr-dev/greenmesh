import React from "react";
import { ScrollView, View, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import {
  updateSettings,
  fetchModels,
  testConnection,
  clearAllConversations,
  resetUserData,
} from "../features/chat/chatSlice";
import { persistor } from "../app/store";
import {
  downloadWhisperPreset,
  deleteWhisperModel,
  loadWhisperModel,
  refreshWhisperModels,
  setDictationSettings,
  clearDictationError,
} from "../features/dictation/dictationSlice";
import { PRESETS as WHISPER_PRESETS } from "../local/whisperStore";
import { PIPER_VOICES } from "../local/hfStore";
import {
  downloadVoice,
  deleteVoice,
  downloadFromHuggingFace,
  setSpeechSettings,
  stopSpeech,
  clearSpeechError,
  refreshVoices,
  selectVoice,
} from "../features/speech/speechSlice";
import * as eventLog from "../server/eventLog";
import { Text, Card, SectionTitle, Button, Field, Pill, Stepper, Banner } from "../components/ui";
import { colors, spacing, font, radius, type as typography } from "../theme";

const ENDPOINTS = [
  { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { label: "Together", url: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { label: "Ollama (PC)", url: "http://192.168.1.10:11434/v1", model: "llama3.2" },
  { label: "LM Studio", url: "http://192.168.1.10:1234/v1", model: "local-model" },
];

const REMOTE_ENDPOINTS = [
  { method: "GET", path: "/v1/mesh/status", desc: "node, model, params, server and router state" },
  { method: "GET", path: "/v1/mesh/nodes", desc: "every worker in the mesh (peer keys redacted)" },
  { method: "POST", path: "/v1/mesh/scan", desc: "{deep?:bool} sweep the Wi-Fi, add verified OpenAI servers" },
  { method: "POST", path: "/v1/mesh/nodes", desc: "{ip,port?,key?} test one address and add it as a worker" },
  { method: "DELETE", path: "/v1/mesh/nodes", desc: "{id|ip} drop a worker" },
  { method: "GET", path: "/v1/mesh/params", desc: "current on-device and server parameters" },
  { method: "POST", path: "/v1/mesh/params", desc: "{nCtx,nThreads,temperature,maxTokens,topP,systemPrompt,port,apiKey} - reloads or restarts as needed" },
  { method: "POST", path: "/v1/mesh/model/load", desc: "{name?} load a downloaded model (first one if omitted)" },
  { method: "POST", path: "/v1/mesh/model/download", desc: "{url,name?} download a .gguf straight onto the node" },
  { method: "GET", path: "/v1/mesh/models", desc: "downloaded models, projectors and what is loaded" },
  { method: "POST", path: "/v1/mesh/coordinator", desc: "{on} make this node the mesh coordinator" },
  { method: "POST", path: "/v1/mesh/model/unload", desc: "free the model and its memory" },
  { method: "POST", path: "/v1/mesh/model/reload", desc: "reload the current model with the current params" },
  { method: "POST", path: "/v1/mesh/server/start", desc: "start the OpenAI-compatible listener" },
  { method: "POST", path: "/v1/mesh/server/stop", desc: "stop the listener" },
  { method: "POST", path: "/v1/mesh/server/restart", desc: "{port?} restart, optionally on a new port" },
  { method: "GET", path: "/v1/mesh/device", desc: "thermals, battery, paused state, keep-alive status" },
  { method: "POST", path: "/v1/mesh/node/restart", desc: "{delay?} kill and relaunch the app - the node heals itself remotely" },
  { method: "POST", path: "/v1/mesh/node/awake", desc: "re-assert the foreground service and locks" },
  { method: "POST", path: "/v1/mesh/thermal", desc: "{enabled} thermal guard on/off (it pauses the node when hot or nearly flat)" },
  { method: "POST", path: "/v1/mesh/keepalive", desc: "{ask:\"battery\"|\"autostart\"|\"overlay\"} open the OS screens that need one human tap" },
  { method: "GET", path: "/v1/mesh/chats", desc: "chat list: id, title, message count" },
  { method: "POST", path: "/v1/mesh/chats/export", desc: "{format:jsonl|md|json} -> {name, content} for a backup" },
  { method: "POST", path: "/v1/mesh/chats/import", desc: "{content} merge chats in from anywhere (dedupes)" },
  { method: "GET", path: "/v1/mesh/log", desc: "{limit?} recent request log" },
  { method: "GET", path: "/v1/mesh/tools", desc: "tools the coordinator model may call" },
  { method: "POST", path: "/v1/mesh/policy", desc: "{policy} local-first | least-busy | round-robin | model-match | smart" },
  { method: "POST", path: "/v1/mesh/planner", desc: "{on} planner mode for incoming requests" },
  { method: "POST", path: "/v1/mesh/plan", desc: "{goal,format?} plan the job, dispatch the steps, merge the answers" },
  { method: "POST", path: "/v1/mesh/agent", desc: "{instruction} the phone's model picks tools itself, returns the trace" },
  { method: "POST", path: "/v1/mesh/jobs", desc: "{prompts[]} fan a batch over the workers" },
];

export default function SettingsPage() {
  const dispatch = useDispatch();
  const { settings, api, conversations, order, server: serverState } = useSelector((state) => state.chat);
  const dictation = useSelector((state) => state.dictation);
  const speech = useSelector((state) => state.speech);
  const [devEvents, setDevEvents] = React.useState([]);
  const [eventSummary, setEventSummary] = React.useState({ count: 0, verbose: true });

  const refreshEvents = React.useCallback(() => {
    setDevEvents(eventLog.getEvents(40));
    setEventSummary(eventLog.summary());
  }, []);

  React.useEffect(() => {
    dispatch(refreshVoices());
    refreshEvents();
    const timer = setInterval(refreshEvents, 4000);
    return () => clearInterval(timer);
  }, [dispatch, refreshEvents]);

  const set = (patch) => dispatch(updateSettings(patch));

  const storedMessages = order.reduce(
    (total, id) => total + ((conversations[id] && conversations[id].messages.length) || 0),
    0
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionTitle>Quick endpoint</SectionTitle>
      <View style={styles.presetWrap}>
        {ENDPOINTS.map((endpoint) => (
          <TouchableOpacity
            key={endpoint.label}
            style={styles.endpointChip}
            onPress={() => set({ baseUrl: endpoint.url, model: endpoint.model })}
          >
            <Text style={styles.endpointText}>{endpoint.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <SectionTitle>Connection</SectionTitle>
      <Card>
        <Field
          label="API base URL (OpenAI compatible)"
          value={settings.baseUrl}
          onChangeText={(value) => set({ baseUrl: value })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label="API key"
          value={settings.apiKey}
          onChangeText={(value) => set({ apiKey: value })}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="sk-... (may be empty for a local server)"
        />
        <Field
          label="Model"
          value={settings.model}
          onChangeText={(value) => set({ model: value })}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.buttonRow}>
          <Button
            title="Fetch model list"
            small
            variant="secondary"
            style={styles.halfButton}
            loading={api.fetchingModels}
            onPress={() => dispatch(fetchModels())}
          />
          <Button
            title="Test connection"
            small
            style={styles.halfButton}
            loading={api.testing}
            onPress={() => dispatch(testConnection())}
          />
        </View>

        {api.testResult ? (
          <Banner
            tone={api.testResult.ok ? "success" : "danger"}
            title={api.testResult.ok ? "Connection OK" : "Connection failed"}
            text={
              api.testResult.ok
                ? `HTTP ${api.testResult.status} in ${api.testResult.ms} ms`
                : `${api.testResult.error || "no response"}`
            }
          />
        ) : null}

        {settings.availableModels.length > 0 ? (
          <View style={styles.modelsBox}>
            <Text style={typography.label}>Models on the endpoint ({settings.availableModels.length})</Text>
            {settings.availableModels.slice(0, 12).map((name) => (
              <TouchableOpacity key={name} onPress={() => set({ model: name })} style={styles.modelRow}>
                <Text style={styles.modelRowText} numberOfLines={1}>
                  {name}
                </Text>
                {settings.model === name ? <Pill label="selected" tone="success" /> : null}
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </Card>

      <SectionTitle>API parameters</SectionTitle>
      <Card>
        <Stepper
          label="Temperature"
          value={settings.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(value) => set({ temperature: value })}
          format={(value) => value.toFixed(1)}
        />
        <Stepper
          label="Max response tokens"
          value={settings.maxTokens}
          min={16}
          max={4096}
          step={16}
          onChange={(value) => set({ maxTokens: value })}
        />
      </Card>

      <SectionTitle>App memory</SectionTitle>
      <Card>
        <View style={styles.memoryRow}>
          <Text style={styles.memoryLabel}>Saved chats</Text>
          <Pill label={`${order.length}`} tone={order.length ? "primary" : "default"} />
        </View>
        <View style={styles.memoryRow}>
          <Text style={styles.memoryLabel}>Saved messages</Text>
          <Pill label={`${storedMessages}`} tone="default" />
        </View>
        <View style={styles.memoryRow}>
          <Text style={styles.memoryLabel}>API key</Text>
          <Pill label={settings.apiKey ? "stored" : "not set"} tone={settings.apiKey ? "success" : "default"} />
        </View>

        <Button
          title="Clear chats"
          variant="secondary"
          style={styles.cardButton}
          onPress={() =>
            Alert.alert("Clear chats", "Delete all saved chats?", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => dispatch(clearAllConversations()) },
            ])
          }
        />
        <Button
          title="Clear all app data"
          variant="danger"
          style={styles.cardButton}
          onPress={() =>
            Alert.alert(
              "Clear app data",
              "This removes settings, chats and on-device parameters. Downloaded model files stay.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Clear",
                  style: "destructive",
                  onPress: async () => {
                    dispatch(resetUserData());
                    await persistor.purge();
                    await persistor.flush();
                  },
                },
              ]
            )
          }
        />
      </Card>

      <SectionTitle right={serverState.running ? `:${serverState.port}` : "server off"}>
        Remote control API
      </SectionTitle>
      <Card>
        <Text style={styles.note}>
          Anything the Router tab does by hand, a remote planner can do over HTTP - GreenMesh on a
          laptop, another phone, a cron job, any third-party code on this LAN. Base URL is the same as
          the model endpoint. Every install starts with the shared default key (greenmesh-mesh-default),
          so send Authorization: Bearer &lt;key&gt;; change the key on the Server tab and on all your
          nodes to lock the mesh down. Nothing here can run arbitrary code or reach outside the local
          network.
        </Text>
        {REMOTE_ENDPOINTS.map((row) => (
          <View key={`${row.method}-${row.path}`} style={styles.apiRow}>
            <Pill label={row.method} tone={row.method === "GET" ? "info" : "primary"} />
            <View style={{ flex: 1 }}>
              <Text style={styles.apiPath}>{row.path}</Text>
              <Text style={styles.apiDesc}>{row.desc}</Text>
            </View>
          </View>
        ))}
        <Text style={styles.apiExample}>
          {`# status of this node\ncurl -s http://${serverState.ip || "<phone-ip>"}:${serverState.port}/v1/mesh/status\n\n# change parameters (reloads the model when context or threads change)\ncurl -s -X POST http://${serverState.ip || "<phone-ip>"}:${serverState.port}/v1/mesh/params \\\n  -H 'Content-Type: application/json' \\\n  -d '{"nCtx":4096,"temperature":0.6,"maxTokens":256}'\n\n# free the model, then load it again with the new parameters\ncurl -s -X POST .../v1/mesh/model/unload\ncurl -s -X POST .../v1/mesh/model/reload\n\n# restart the listener, optionally on another port\ncurl -s -X POST .../v1/mesh/server/restart -d '{"port":8081}'\n\n# let the phone's model plan a job and farm the steps out\ncurl -s -X POST .../v1/mesh/plan -d '{"goal":"Compare solar vs wind for a small house"}'`}
        </Text>
      </Card>

      <SectionTitle>Dictation</SectionTitle>
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.rowTitle}>Voice input</Text>
          <Pill
            label={dictation.loaded ? "model ready" : dictation.name ? "model idle" : "no model"}
            tone={dictation.loaded ? "success" : dictation.name ? "warn" : "default"}
          />
        </View>
        <Text style={styles.rowHint}>
          Tap the Mic button in a chat to dictate: tap once to start and again to stop, or hold it to
          talk. The first tap downloads a speech model automatically; after that transcription happens on
          this phone and no audio leaves the device. The models below are optional - pick a bigger one if
          your dictation needs to be more accurate.
        </Text>
        {dictation.error ? (
          <TouchableOpacity onPress={() => dispatch(clearDictationError())}>
            <Text style={styles.rowError}>{dictation.error} (tap to dismiss)</Text>
          </TouchableOpacity>
        ) : null}

        {WHISPER_PRESETS.map((preset) => {
          const installed = (dictation.models || []).find((model) => model.name === preset.name);
          const chosen = dictation.name === preset.name;
          const busy = dictation.downloading === preset.id;
          return (
            <View key={preset.id} style={styles.presetRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.presetTitle}>
                  {preset.label} - {preset.sizeLabel}
                  {chosen ? "  (in use)" : ""}
                </Text>
                <Text style={styles.rowHint}>{preset.note}</Text>
                {busy ? (
                  <Text style={styles.presetProgress}>
                    downloading {Math.round((dictation.progress || 0) * 100)}%
                  </Text>
                ) : null}
              </View>
              {installed ? (
                <View style={styles.presetActions}>
                  <TouchableOpacity
                    onPress={() => dispatch(loadWhisperModel({ path: installed.path, name: installed.name }))}
                  >
                    <Text style={styles.rowAction}>{chosen && dictation.loaded ? "Reload" : "Use"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() =>
                      Alert.alert("Delete model", `Delete ${preset.name}?`, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => dispatch(deleteWhisperModel(preset.name)),
                        },
                      ])
                    }
                  >
                    <Text style={styles.rowDanger}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => dispatch(downloadWhisperPreset(preset.id))}
                  disabled={Boolean(dictation.downloading)}
                >
                  <Text style={styles.rowAction}>{busy ? "..." : "Download"}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        <TouchableOpacity
          style={styles.pillRow}
          onPress={() => dispatch(setDictationSettings({ autoSend: !dictation.settings.autoSend }))}
        >
          <Pill
            label={dictation.settings.autoSend ? "send after dictation: on" : "send after dictation: off"}
            tone={dictation.settings.autoSend ? "success" : "default"}
          />
          <Text style={styles.rowHint}>
            Send the message as soon as the transcript is ready, instead of leaving it in the box for you
            to check
          </Text>
        </TouchableOpacity>

        <Text style={styles.rowTitle}>Spoken language</Text>
        <View style={styles.langRow}>
          {[
            { id: "auto", label: "Auto" },
            { id: "en", label: "English" },
            { id: "pl", label: "Polski" },
          ].map((option) => (
            <TouchableOpacity
              key={option.id}
              style={[styles.langChip, dictation.settings.language === option.id && styles.langChipActive]}
              onPress={() => dispatch(setDictationSettings({ language: option.id }))}
            >
              <Text
                style={[
                  styles.langText,
                  dictation.settings.language === option.id && styles.langTextActive,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.rowHint}>
          Auto-detection works with the multilingual models; the English-only models always want English.
        </Text>
      </Card>

      <SectionTitle>Speech (text to speech)</SectionTitle>
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.rowTitle}>Voice</Text>
          <Pill
            label={
              speech.speaking
                ? "speaking"
                : speech.settings.engine === "piper" && speech.settings.voiceId
                ? `on-device: ${speech.settings.voiceId}`
                : "phone engine"
            }
            tone={speech.speaking ? "success" : speech.settings.engine === "piper" ? "primary" : "default"}
          />
        </View>
        <Text style={styles.rowHint}>
          Two ways to talk. The phone's own engine needs no download and is the default. A downloaded
          Piper voice below is synthesised on this phone by sherpa-onnx - tap Use next to one and it
          takes over, fully offline. Long replies are cut to their first ~600 characters rather than
          reading an essay out loud.
        </Text>
        <TouchableOpacity style={styles.pillRow} onPress={() => dispatch(selectVoice(null))}>
          <Pill
            label={speech.settings.engine === "system" ? "use the phone engine" : "switch to phone engine"}
            tone={speech.settings.engine === "system" ? "success" : "default"}
          />
          <Text style={styles.rowHint}>Go back to the built-in voice</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.pillRow}
          onPress={() => dispatch(setSpeechSettings({ autoSpeak: !speech.settings.autoSpeak }))}
        >
          <Pill
            label={speech.settings.autoSpeak ? "read replies aloud: on" : "read replies aloud: off"}
            tone={speech.settings.autoSpeak ? "success" : "default"}
          />
          <Text style={styles.rowHint}>Speak every assistant reply as it arrives</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.pillRow} onPress={() => dispatch(stopSpeech())}>
          <Pill label="stop speaking" tone="warn" />
          <Text style={styles.rowHint}>Cut off whatever is being read right now</Text>
        </TouchableOpacity>
        {speech.error ? (
          <TouchableOpacity onPress={() => dispatch(clearSpeechError())}>
            <Text style={styles.rowError}>{speech.error} (tap to dismiss)</Text>
          </TouchableOpacity>
        ) : null}

        {PIPER_VOICES.map((voice) => {
          const installed = (speech.voices || []).find((item) => item.id === voice.id);
          const busy = speech.downloading === voice.id;
          return (
            <View key={voice.id} style={styles.presetRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.presetTitle}>
                  {voice.label} - {voice.sizeLabel}
                </Text>
                <Text style={styles.rowHint}>{voice.note}</Text>
                {busy ? (
                  <Text style={styles.presetProgress}>
                    downloading {Math.round((speech.progress || 0) * 100)}%
                  </Text>
                ) : null}
              </View>
              {installed ? (
                <View style={styles.presetActions}>
                  <TouchableOpacity onPress={() => dispatch(selectVoice(voice.id))}>
                    <Text style={styles.rowAction}>
                      {speech.settings.voiceId === voice.id ? "In use" : "Use"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => dispatch(deleteVoice(voice.id))}>
                    <Text style={styles.rowDanger}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => dispatch(downloadVoice(voice.id))}
                  disabled={Boolean(speech.downloading)}
                >
                  <Text style={styles.rowAction}>{busy ? "..." : "Download"}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        <Text style={styles.rowTitle}>Any Hugging Face model</Text>
        <Text style={styles.rowHint}>
          For anything not listed here. The file is saved by its type: .gguf to chat models, ggml-*.bin
          to Whisper (STT), .onnx to TTS voices.
        </Text>
        <Field
          label="repo (user/name)"
          value={speech.hfRepo}
          onChangeText={(value) => dispatch(setHfTarget({ repo: value }))}
          placeholder="ggerganov/whisper.cpp"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
        />
        <Field
          label="file inside the repo"
          value={speech.hfFile}
          onChangeText={(value) => dispatch(setHfTarget({ file: value }))}
          placeholder="ggml-tiny.en-q5_1.bin"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
        />
        <Button
          title={speech.hfDownloading ? `Downloading ${Math.round((speech.progress || 0) * 100)}%` : "Download from Hugging Face"}
          onPress={() => dispatch(downloadFromHuggingFace({ repo: speech.hfRepo, file: speech.hfFile }))}
          disabled={speech.hfDownloading || !speech.hfRepo.trim() || !speech.hfFile.trim()}
        />
        {speech.hfResult ? (
          <Text style={styles.rowHint}>
            Saved {speech.hfResult.name} ({Math.round((speech.hfResult.size || 0) / 1048576)} MB) to{" "}
            {speech.hfResult.path}
          </Text>
        ) : null}
      </Card>

      <SectionTitle right={`${eventSummary.count} events`}>Diagnostics</SectionTitle>
      <Card>
        <TouchableOpacity
          style={styles.pillRow}
          onPress={() => {
            eventLog.setVerbose(!eventSummary.verbose);
            refreshEvents();
          }}
        >
          <Pill
            label={eventSummary.verbose ? "verbose logging: on" : "verbose logging: off"}
            tone={eventSummary.verbose ? "success" : "default"}
          />
          <Text style={styles.rowHint}>
            Record every step this node takes - model loads, downloads, dictation, mesh calls - in the
            log below and in the console. Readable remotely at GET /v1/mesh/events.
          </Text>
        </TouchableOpacity>
        <View style={styles.pillRow}>
          <TouchableOpacity onPress={refreshEvents}>
            <Text style={styles.rowAction}>Refresh</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              eventLog.clearEvents();
              refreshEvents();
            }}
          >
            <Text style={styles.rowDanger}>Clear</Text>
          </TouchableOpacity>
        </View>
        {(devEvents || []).slice(0, 14).map((entry, index) => (
          <View key={`${entry.ts}-${index}`} style={styles.eventRow}>
            <Text style={styles.eventTime}>
              {new Date(entry.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </Text>
            <Text style={[styles.eventText, entry.level === "error" && styles.eventError]}>
              {entry.event}
              {entry.details ? `  ${JSON.stringify(entry.details).slice(0, 70)}` : ""}
            </Text>
          </View>
        ))}
        {eventSummary.count === 0 ? <Text style={styles.rowHint}>Nothing recorded yet.</Text> : null}
      </Card>

      <SectionTitle>Keeping the node alive</SectionTitle>
      <Card>
        <Text style={styles.note}>
          While the server runs, the app holds a wake lock behind a small "GreenMesh node"
          notification, so Android doze cannot drop this phone out of the mesh mid-job. Two things
          stay in your hands: swiping the app away no longer stops the service
          (stopWithTask=false), but a Force stop or MIUI's cleaner still kills it - and only you can
          grant autostart. On Xiaomi/Redmi enable Settings - Apps - GreenMesh AI - Autostart, and set
          battery saver to "No restrictions", otherwise the system may freeze the node overnight.
        </Text>
      </Card>

      <Text style={styles.note}>
        Everything is stored locally on the phone (AsyncStorage) and comes back after a restart. The
        API key is not encrypted - do not hand the device to anyone you would not share it with.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing(4), paddingBottom: spacing(10) },
  presetWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  endpointChip: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2.2),
  },
  endpointText: { color: colors.primary, fontWeight: "700", fontSize: font(13) },
  buttonRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(3) },
  halfButton: { flex: 1 },
  modelsBox: { marginTop: spacing(4) },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing(2),
  },
  modelRowText: { flex: 1, color: colors.text, fontSize: font(13.5) },
  memoryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing(2),
  },
  memoryLabel: { color: colors.textSoft, fontSize: font(14) },
  apiRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing(2.5),
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  apiPath: { ...typography.mono, color: colors.text, fontSize: font(12.5) },
  apiDesc: { ...typography.small, marginTop: 2, lineHeight: 16 },
  apiExample: {
    ...typography.mono,
    fontSize: font(11),
    lineHeight: 16,
    marginTop: spacing(3),
    color: colors.textSoft,
  },
  cardButton: { marginTop: spacing(3) },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowTitle: { color: colors.text, fontWeight: "700", fontSize: font(14), marginTop: spacing(3) },
  rowHint: { ...typography.small, marginTop: spacing(1) },
  rowError: { color: colors.danger, fontSize: font(12.5), marginTop: spacing(2) },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing(2),
    marginTop: spacing(1.5),
    paddingTop: spacing(1.5),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  eventTime: { ...typography.mono, color: colors.textSoft, fontSize: font(11) },
  eventText: { flex: 1, color: colors.text, fontSize: font(11.5) },
  eventError: { color: colors.danger },
  rowAction: { color: colors.primary, fontWeight: "700", fontSize: font(13), paddingHorizontal: spacing(2) },
  rowDanger: { color: colors.danger, fontWeight: "700", fontSize: font(13), paddingHorizontal: spacing(2) },
  pillRow: { flexDirection: "row", alignItems: "center", gap: spacing(2.5), marginTop: spacing(3) },
  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing(2),
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  presetTitle: { color: colors.text, fontWeight: "700", fontSize: font(13.5) },
  presetProgress: { color: colors.primary, fontSize: font(12.5), marginTop: spacing(1) },
  presetActions: { flexDirection: "row", alignItems: "center", gap: spacing(1) },
  langRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(2) },
  langChip: {
    paddingHorizontal: spacing(3.5),
    paddingVertical: spacing(2),
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  langChipActive: { backgroundColor: colors.primarySoft },
  langText: { color: colors.textSoft, fontWeight: "700", fontSize: font(12.5) },
  langTextActive: { color: colors.primary },
  note: { ...typography.small, marginTop: spacing(5), lineHeight: 18 },
});
