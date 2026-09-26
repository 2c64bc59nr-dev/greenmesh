import React, { useEffect, useState } from "react";
import { AppRegistry, PermissionsAndroid, Platform, View, TouchableOpacity, StyleSheet, SafeAreaView, StatusBar, ActivityIndicator, TextInput } from "react-native";
import { Provider, useDispatch, useSelector } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { registerRootComponent } from "expo";
import { store, persistor } from "./src/app/store";
import ConversationsPage from "./src/pages/ConversationsPage";
import ChatPage from "./src/pages/ChatPage";
import SettingsPage from "./src/pages/SettingsPage";
import LocalModelPage from "./src/pages/LocalModelPage";
import ServerPage from "./src/pages/ServerPage";
import RouterPage from "./src/pages/RouterPage";
import { backToList, startInferenceServer, loadLocalModel, refreshLocalModels } from "./src/features/chat/chatSlice";
import { installMeshApi, installRouterHandler } from "./src/features/router/routerSlice";
import { applyServerApiKey } from "./src/features/chat/chatSlice";
import { DEFAULT_API_KEY } from "./src/config";
import * as thermals from "./src/server/thermals";
import { refreshWhisperModels } from "./src/features/dictation/dictationSlice";
import { Text, FixedText, Pill } from "./src/components/ui";
import { colors, radius, spacing, font, type as typography, tabs, layout } from "./src/theme";

const TABS = [
  { key: "list", label: "Chats" },
  { key: "local", label: "Model" },
  { key: "server", label: "Server" },
  { key: "router", label: "Router" },
  { key: "settings", label: "Settings" },
];

function TabBar({ active, onChange }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map((tab) => {
        const isActive = active === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, isActive && styles.tabActive]}
            onPress={() => onChange(tab.key)}
          >
            <FixedText style={[styles.tabText, isActive && styles.tabTextActive]} numberOfLines={1}>
              {tab.label}
            </FixedText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function BootScreen() {
  return (
    <View style={styles.boot}>
      <Text style={styles.bootBrand}>GreenMesh</Text>
      <ActivityIndicator color={colors.primary} style={{ marginTop: spacing(4) }} />
      <Text style={styles.bootText}>Loading saved data...</Text>
    </View>
  );
}

/**
 * Bring the node's model up if it should be up.
 *
 * A worker node with a model on disk and nothing loaded is a wasted node, so if
 * the phone has no memory of which model it used last (fresh install, or the
 * record was lost), fall back to the first model actually on disk.
 */
async function autoLoadModelIfNeeded(nodeStore, chat) {
  const state = nodeStore.getState().chat;
  if (state.settings.autoLoadModel === false) return;
  if (state.local.ready || state.local.loading) return;

  const { lastModelPath, lastModelName } = state.local;
  if (lastModelPath) {
    nodeStore.dispatch(chat.loadLocalModel({ path: lastModelPath, name: lastModelName }));
    return;
  }

  const result = await nodeStore.dispatch(chat.refreshLocalModels()).catch(() => null);
  const models = (result && result.payload && result.payload.models) || [];
  if (models.length) {
    nodeStore.dispatch(chat.loadLocalModel({ path: models[0].path, name: models[0].name }));
  }
}

function Root() {
  const dispatch = useDispatch();
  const currentId = useSelector((state) => state.chat.currentId);
  const mode = useSelector((state) => state.chat.mode);
  const settings = useSelector((state) => state.chat.settings);
  const local = useSelector((state) => state.chat.local);
  const serverState = useSelector((state) => state.chat.server);
  const routerState = useSelector((state) => state.router);
  const [tab, setTab] = useState("list");
  const [chatOpen, setChatOpen] = useState(false);

  // Android 13+ hides every notification - including the node's own "I am
  // serving" one - until POST_NOTIFICATIONS is granted. A worker node whose
  // notification is invisible looks like it is not running.
  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
        const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
        const granted = await PermissionsAndroid.check(permission);
        if (!granted) await PermissionsAndroid.request(permission);
      } catch (error) {
        // the node still serves without it; only the notification is invisible
      }
    })();
  }, []);

  // Dictation needs the microphone, and Android will not even list it until it
  // is asked for. Asked here so the first tap on the mic button just works.
  useEffect(() => {
    dispatch(refreshWhisperModels());
    (async () => {
      try {
        if (Platform.OS !== "android") return;
        const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
        const granted = await PermissionsAndroid.check(permission);
        if (!granted) await PermissionsAndroid.request(permission);
      } catch (error) {
        // dictation will ask again on first use
      }
    })();
  }, [dispatch]);

  // Fresh install: protect the server with the shared default key instead of
  // serving wide open. Changing it on the Server tab (or remotely via
  // /v1/mesh/params) overrides this for good.
  useEffect(() => {
    if (!String(serverState.apiKey || "").trim()) dispatch(applyServerApiKey(DEFAULT_API_KEY));
  }, [dispatch, serverState.apiKey]);

  // The remote control API (/v1/mesh/*) is always available: a planner somewhere
  // else can read this node's status and drive it without a human present.
  // A node that was the coordinator comes back as one.
  useEffect(() => {
    dispatch(installMeshApi());
    if (routerState.coordinator) dispatch(installRouterHandler());
  }, [dispatch, routerState.coordinator]);

  // A phone that is meant to serve jobs should not need a human to press start
  // after every reboot: bring the listener up as soon as the app is open, and
  // re-load the model this node used last.
  useEffect(() => {
    if (settings.autoStartServer === false) return;
    if (serverState.running || serverState.starting) return;
    dispatch(startInferenceServer());
  }, [dispatch, settings.autoStartServer, serverState.running, serverState.starting]);

  useEffect(() => {
    if (settings.autoLoadModel === false) return;
    if (local.ready || local.loading) return;
    autoLoadModelIfNeeded(store, {
      loadLocalModel,
      refreshLocalModels,
    });
  }, [dispatch, settings.autoLoadModel, local.ready, local.loading, local.lastModelPath, local.lastModelName]);

  /**
   * Watch the phone's thermals and battery: above the thresholds the node stops
   * taking jobs and says so in /health, instead of cooking the phone (and being
   * killed by Android for it).
   */
  useEffect(() => {
    thermals.startThermalWatch();
    return () => thermals.stopThermalWatch();
  }, []);

  /**
   * Watchdog. A distributed cluster is only as good as its ability to heal
   * itself: every minute, if this node should be serving and is not, it puts
   * itself back together without anyone touching the phone.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const state = store.getState().chat;
      if (state.settings.autoStartServer !== false && !state.server.running && !state.server.starting) {
        dispatch(startInferenceServer());
        return;
      }
      autoLoadModelIfNeeded(store, { loadLocalModel, refreshLocalModels });
    }, 60000);
    return () => clearInterval(timer);
  }, [dispatch]);

  const inChat = chatOpen && Boolean(currentId);

  const subtitle = inChat
    ? mode === "local"
      ? local.ready
        ? `${local.name} (CPU)`
        : "on-device model not loaded"
      : settings.model
    : serverState.running
    ? `server on :${serverState.port}`
    : mode === "local"
    ? "on-device mode"
    : "API mode";

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.brand}>GreenMesh</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {serverState.running ? <Pill label="serving" tone="success" /> : null}
          <Pill label={mode === "local" ? "CPU" : "API"} tone={mode === "local" ? "info" : "primary"} />
          {inChat ? (
            <TouchableOpacity
              style={styles.backChip}
              onPress={() => {
                dispatch(backToList());
                setChatOpen(false);
              }}
            >
              <Text style={styles.backChipText}>Back</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.body}>
        {inChat ? (
          <ChatPage />
        ) : tab === "settings" ? (
          <SettingsPage />
        ) : tab === "local" ? (
          <LocalModelPage />
        ) : tab === "router" ? (
          <RouterPage />
        ) : tab === "server" ? (
          <ServerPage />
        ) : (
          <ConversationsPage onOpen={() => setChatOpen(true)} />
        )}
      </View>

      {inChat ? null : <TabBar active={tab} onChange={setTab} />}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={<BootScreen />} persistor={persistor}>
        <Root />
      </PersistGate>
    </Provider>
  );
}

try {
  registerRootComponent(App);
} catch (error) {
  // already registered by expo/AppEntry.js
}

/**
 * Headless bootstrap: the node comes up with no UI at all.
 *
 * Android calls this from NodeTaskService on boot, after an app update, or after
 * a hard restart. Nothing is mounted, so this is the only code that runs - wait
 * for the persisted state, start the listener, and reload the model this phone
 * used last. That is what lets a phone nobody has touched serve jobs again.
 */
let headlessWatchdogArmed = false;

AppRegistry.registerHeadlessTask("GreenMeshNodeTask", () => async () => {
  const { store: nodeStore, persistor: nodePersistor } = require("./src/app/store");
  const chat = require("./src/features/chat/chatSlice");

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      if (nodePersistor.getState().bootstrapped) return finish();
      const unsubscribe = nodePersistor.subscribe(() => {
        if (nodePersistor.getState().bootstrapped) {
          unsubscribe();
          finish();
        }
      });
    } catch (error) {
      // fall through to the timeout
    }
    setTimeout(finish, 8000);
  });

  const state = nodeStore.getState().chat;
  if (state.settings.autoStartServer !== false && !state.server.running) {
    nodeStore.dispatch(chat.startInferenceServer());
  }
  // A node with no UI must still be controllable and must still route if it was
  // the coordinator: install the remote API and re-arm the router handler.
  const router = require("./src/features/router/routerSlice");
  nodeStore.dispatch(router.installMeshApi());
  if (nodeStore.getState().router.coordinator) {
    nodeStore.dispatch(router.installRouterHandler());
  }
  const { lastModelPath, lastModelName, ready } = state.local;
  if (state.settings.autoLoadModel !== false && !ready) {
    await autoLoadModelIfNeeded(nodeStore, chat);
  }
  // Make sure the model choice survives the next crash or update: redux-persist
  // writes in the background and a process kill can beat it.
  try {
    await nodePersistor.flush();
  } catch (error) {
    // not fatal - the node is serving, only the memory of the model is at risk
  }

  // The headless process has no React tree, so the app's own watchdog never
  // mounts: keep an equivalent one here, for as long as Android keeps us alive.
  // Armed once - the native health check re-runs this task every couple of
  // minutes and must not stack timers.
  if (headlessWatchdogArmed) return;
  headlessWatchdogArmed = true;
  setInterval(() => {
    const now = nodeStore.getState().chat;
    if (now.settings.autoStartServer !== false && !now.server.running && !now.server.starting) {
      nodeStore.dispatch(chat.startInferenceServer());
      return;
    }
    autoLoadModelIfNeeded(nodeStore, chat);
  }, 60000);
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3.5),
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerLeft: { flex: 1 },
  brand: { fontSize: font(21), fontWeight: "800", color: colors.text, letterSpacing: -0.4, ...typography.mono },
  subtitle: { ...typography.small, marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: spacing(2) },
  backChip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(3.5),
    paddingVertical: spacing(1.8),
  },
  backChipText: { color: colors.text, fontWeight: "700", fontSize: font(13) },
  body: { flex: 1 },
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  bootBrand: { fontSize: font(24), fontWeight: "800", color: colors.primary, letterSpacing: 2, ...typography.mono },
  bootText: { ...typography.small, marginTop: spacing(3) },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing(3),
    paddingTop: spacing(2),
    paddingBottom: tabs.paddingBottom,
    gap: spacing(1.5),
  },
  tab: {
    flex: 1,
    paddingVertical: tabs.paddingVertical,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  tabActive: { backgroundColor: colors.primarySoft },
  tabText: { color: colors.muted, fontWeight: "700", fontSize: tabs.fontSize },
  tabTextActive: { color: colors.primary },
});
