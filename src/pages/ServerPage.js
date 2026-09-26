import React, { useEffect } from "react";
import { View, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSelector, useDispatch } from "react-redux";
import {
  startInferenceServer,
  stopInferenceServer,
  refreshServerStatus,
  setServerPort,
  setServerApiKey,
  applyServerApiKey,
  changeServerPort,
  clearServerError,
  clearServerLog,
  updateSettings,
} from "../features/chat/chatSlice";
import * as keepAwake from "../server/keepAwake";
import * as thermals from "../server/thermals";
import { DEFAULT_API_KEY_HINT } from "../config";
import { Text, Card, SectionTitle, Button, Field, Pill, Stepper, Banner, EmptyState } from "../components/ui";
import { colors, spacing, font, radius, type as typography } from "../theme";

const PORTS = [8000, 8080, 8081, 9000];

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

export default function ServerPage() {
  const dispatch = useDispatch();
  const serverState = useSelector((state) => state.chat.server);
  const local = useSelector((state) => state.chat.local);
  const settings = useSelector((state) => state.chat.settings);
  const [awake, setAwake] = React.useState(false);
  const [exempt, setExempt] = React.useState(null);
  const [device, setDevice] = React.useState(null);

  // Thermals/battery for the row above, and whether Android is allowed to freeze us
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const status = await keepAwake.getDeviceStatus();
      const allowed = await keepAwake.isBatteryExempt();
      if (!alive) return;
      setExempt(allowed);
      const summary = thermals.getSummary();
      setDevice({
        thermalLabel: (status && status.thermalLabel) || summary.thermalLabel || "unknown",
        batteryTempC: status ? status.batteryTempC : summary.batteryTempC,
        batteryLevel: status ? status.batteryLevel : summary.batteryLevel,
        charging: status ? Boolean(status.charging) : Boolean(summary.charging),
        paused: summary.paused,
        reason: summary.reason || "",
      });
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    dispatch(refreshServerStatus());
    const timer = setInterval(() => dispatch(refreshServerStatus()), 2500);
    return () => clearInterval(timer);
  }, [dispatch]);

  const baseUrl = serverState.ip
    ? `http://${serverState.ip}:${serverState.port}/v1`
    : `http://<phone-ip>:${serverState.port}/v1`;

  const copyUrl = async () => {
    await Clipboard.setStringAsync(baseUrl);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionTitle right={serverState.running ? "running" : "stopped"}>Inference server</SectionTitle>
      <Card>
        <View style={styles.statusRow}>
          <View style={[styles.dot, serverState.running ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.statusText}>
            {serverState.running ? "Serving on your network" : "Server is stopped"}
          </Text>
        </View>

        {serverState.running ? (
          <>
            <Text style={styles.urlLabel}>OpenAI-compatible base URL</Text>
            <TouchableOpacity style={styles.urlBox} onPress={copyUrl}>
              <Text style={styles.urlText} numberOfLines={2}>
                {baseUrl}
              </Text>
              <Text style={styles.copyHint}>tap to copy</Text>
            </TouchableOpacity>
            <View style={styles.pillRow}>
              <Pill label={`port ${serverState.port}`} tone="primary" />
              <Pill
                label={local.ready ? `model: ${local.name}` : "no model loaded"}
                tone={local.ready ? "success" : "warn"}
              />
              <Pill label={`${serverState.stats.requests} requests`} tone="default" />
            </View>
            {!local.ready ? (
              <Banner
                tone="warn"
                title="No model loaded"
                text="Load a GGUF model on the Model tab - requests will get HTTP 503 until then."
              />
            ) : null}
            <Button
              title="Stop server"
              variant="danger"
              style={styles.cardButton}
              onPress={() => dispatch(stopInferenceServer())}
            />
          </>
        ) : (
          <Button
            title="Start server"
            loading={serverState.starting}
            style={styles.cardButton}
            onPress={() => dispatch(startInferenceServer())}
          />
        )}
      </Card>

      <SectionTitle>Settings</SectionTitle>
      <Card>
        <Text style={styles.rowTitle}>Node behaviour</Text>
        <TouchableOpacity
          style={styles.pillRow}
          onPress={() => dispatch(updateSettings({ autoStartServer: settings.autoStartServer === false }))}
        >
          <Pill
            label={settings.autoStartServer === false ? "auto-start: off" : "auto-start: on"}
            tone={settings.autoStartServer === false ? "default" : "success"}
          />
          <Text style={styles.rowHint}>
            Start serving as soon as the app opens (no need to press Start after a reboot)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.pillRow}
          onPress={() => dispatch(updateSettings({ autoLoadModel: settings.autoLoadModel === false }))}
        >
          <Pill
            label={settings.autoLoadModel === false ? "auto-load model: off" : "auto-load model: on"}
            tone={settings.autoLoadModel === false ? "default" : "success"}
          />
          <Text style={styles.rowHint}>
            Reload the model this phone used last, so a rebooted node is a worker again and not an empty
            socket answering 503
          </Text>
        </TouchableOpacity>
        {keepAwake.isAvailable() ? (
          <TouchableOpacity
            style={styles.pillRow}
            onPress={() => {
              if (awake) {
                keepAwake.stopServingNotification();
                setAwake(false);
              } else {
                keepAwake.startServingNotification();
                setAwake(true);
              }
            }}
          >
            <Pill label={awake ? "stay awake: on" : "stay awake: off"} tone={awake ? "success" : "default"} />
            <Text style={styles.rowHint}>
              Foreground service + Wi-Fi lock so doze cannot drop this phone out of the mesh. The CPU is
              pinned only while a job is running, so an idle node stays cool and charged.
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.rowHint}>Wake-lock module unavailable in this build.</Text>
        )}
        {keepAwake.isAvailable() ? (
          <>
            <TouchableOpacity
              style={styles.pillRow}
              onPress={() => keepAwake.requestBatteryExemption()}
            >
              <Pill
                label={exempt ? "battery: unrestricted" : "battery: optimised"}
                tone={exempt ? "success" : "warn"}
              />
              <Text style={styles.rowHint}>
                {exempt
                  ? "Android may not freeze this app. Tap to review the setting."
                  : "Tap and allow: without this, Android may freeze the node when the phone is idle"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillRow} onPress={() => keepAwake.openAutoStartSettings()}>
              <Pill label="autostart" />
              <Text style={styles.rowHint}>
                Opens this vendor's autostart/protected-apps screen (MIUI kills background apps unless the
                app is whitelisted there). One tap per phone, only done by hand.
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillRow} onPress={() => keepAwake.openOverlaySettings()}>
              <Pill label="background start" tone="warn" />
              <Text style={styles.rowHint}>
                Allow "display over other apps" - one of the exemptions Android grants apps that must
                start a foreground service from the background, which is how this node heals itself on
                an idle phone
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillRow} onPress={() => keepAwake.restartApp()}>
              <Pill label="restart node" tone="warn" />
              <Text style={styles.rowHint}>
                Kill and relaunch the app now (also remote: POST /v1/mesh/node/restart). The server and the
                model come back on their own.
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
        {device ? (
          <Text style={styles.rowHint}>
            {`thermal: ${device.thermalLabel}  |  battery: ${
              typeof device.batteryTempC === "number" && device.batteryTempC > 0
                ? `${device.batteryTempC.toFixed(1)}C`
                : "n/a"
            }${
              typeof device.batteryLevel === "number" && device.batteryLevel >= 0
                ? `, ${device.batteryLevel}%${device.charging ? " (charging)" : ""}`
                : ""
            }${device.paused ? `  |  PAUSED: ${device.reason}` : ""}`}
          </Text>
        ) : null}
        <Stepper
          label="Port"
          value={serverState.port}
          min={PORTS[0]}
          max={PORTS[PORTS.length - 1]}
          step={1}
          onChange={(value) => dispatch(changeServerPort(value))}
        />
        <View style={styles.portRow}>
          {PORTS.map((port) => (
            <TouchableOpacity
              key={port}
              style={[styles.portChip, serverState.port === port && styles.portChipActive]}
              onPress={() => dispatch(changeServerPort(port))}
            >
              <Text style={[styles.portText, serverState.port === port && styles.portTextActive]}>
                {port}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Field
          label="Required API key"
          value={serverState.apiKey}
          onChangeText={(value) => dispatch(applyServerApiKey(value))}
          autoCapitalize="none"
          autoCorrect={false}
          hint={DEFAULT_API_KEY_HINT}
          placeholder="greenmesh-mesh-default"
        />
        <Text style={styles.note}>
          When set, clients must send: Authorization: Bearer &lt;key&gt;. The server speaks
          /v1/chat/completions (streaming and non-streaming) and /v1/models, so any OpenAI SDK or
          app can point at this phone over Wi-Fi.
        </Text>
      </Card>

      <SectionTitle right={`${serverState.log.length}`}>Request log</SectionTitle>
      {serverState.log.length === 0 ? (
        <Card>
          <Text style={styles.note}>No requests yet.</Text>
        </Card>
      ) : (
        <Card>
          {serverState.log.map((entry, index) => (
            <View key={`${entry.ts}-${index}`} style={styles.logRow}>
              <Text style={styles.logTime}>{formatTime(entry.ts)}</Text>
              <Text style={styles.logPath} numberOfLines={1}>
                {entry.method} {entry.path}
              </Text>
              <Pill
                label={String(entry.status)}
                tone={entry.status === 200 ? "success" : entry.status >= 400 ? "danger" : "default"}
              />
            </View>
          ))}
          <Button
            title="Clear log"
            variant="secondary"
            small
            style={styles.cardButton}
            onPress={() => {
              dispatch(clearServerLog());
            }}
          />
        </Card>
      )}

      {serverState.error ? (
        <Banner
          tone="danger"
          title="Server error"
          text={String(serverState.error)}
          actionLabel="Hide"
          onAction={() => dispatch(clearServerError())}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing(4), paddingBottom: spacing(10) },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing(2.5) },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: colors.primary },
  dotOff: { backgroundColor: colors.muted },
  statusText: { color: colors.text, fontSize: font(15), fontWeight: "600" },
  urlLabel: { ...typography.label, marginTop: spacing(4) },
  urlBox: {
    marginTop: spacing(2),
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(3.5),
  },
  urlText: { ...typography.mono, color: colors.primary, fontSize: font(13.5) },
  copyHint: { ...typography.small, marginTop: spacing(1.5) },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2), marginTop: spacing(3) },
  rowTitle: { fontSize: font(14), fontWeight: "700", color: colors.text },
  rowHint: { ...typography.small, flex: 1, minWidth: 200, lineHeight: 17 },
  cardButton: { marginTop: spacing(3) },
  portRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(2) },
  portChip: {
    flex: 1,
    paddingVertical: spacing(2.2),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  portChipActive: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  portText: { color: colors.textSoft, fontWeight: "700" },
  portTextActive: { color: colors.primary },
  note: { ...typography.small, marginTop: spacing(3), lineHeight: 18 },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing(2.5),
    paddingVertical: spacing(2.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  logTime: { ...typography.small, width: 66 },
  logPath: { flex: 1, color: colors.textSoft, fontSize: font(12.5) },
});
