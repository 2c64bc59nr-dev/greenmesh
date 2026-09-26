import React, { useRef, useState } from "react";
import {
  View,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  Alert,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSelector, useDispatch } from "react-redux";
import {
  startDictation,
  stopDictation,
  cancelDictation,
} from "../features/dictation/dictationSlice";
import { speakText } from "../features/speech/speechSlice";
import {
  sendMessage,
  addUserMessage,
  beginAssistantMessage,
  updateAssistantMessage,
  dropEmptyAssistantMessage,
  setError,
  clearError,
  setMode,
  deleteConversation,
} from "../features/chat/chatSlice";
import { complete } from "../local/llamaService";
import { toChatMessages } from "../features/chat/messageFormat";
import { pickImage, toDataUrl, deleteImage } from "../local/imageStore";
import { Text, Pill, Banner } from "../components/ui";
import { colors, spacing, font, radius, shadow, type as typography } from "../theme";

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export default function ChatPage() {
  const dispatch = useDispatch();
  const listRef = useRef(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [photo, setPhoto] = useState(null);

  const { conversations, currentId, status, error, mode, local, settings } = useSelector(
    (state) => state.chat
  );
  const dictation = useSelector((state) => state.dictation);
  const speech = useSelector((state) => state.speech);

  const conversation = currentId ? conversations[currentId] : null;
  const messages = conversation ? conversation.messages : [];

  const localReady = local.ready;
  const canSend = mode === "local" ? localReady : Boolean(settings.baseUrl);

  const attachPhoto = async () => {
    try {
      dispatch(clearError());
      const picked = await pickImage();
      if (!picked) return;
      if (mode === "local" && localReady && !local.vision) {
        dispatch(
          setError(
            "This model cannot see photos. Load a vision model (Model tab -> a preset with the 'photos' label) or switch to API mode."
          )
        );
      }
      setPhoto(picked);
    } catch (failure) {
      dispatch(setError((failure && failure.message) || "Could not open the photo picker"));
    }
  };

  const clearPhoto = () => {
    if (photo) deleteImage(photo.uri);
    setPhoto(null);
  };

  /** Outgoing history: file:// uri for llama.cpp, data URL for HTTP APIs. */
  const outgoingHistory = (imageUrl) =>
    [...messages, { role: "user", content: input.trim(), imageUrl }].map((message) => ({
      role: message.role,
      content: message.content,
      // older messages keep their stored photo, the new one uses what we resolved
      imageUrl: message.imageUrl || (message.image && message.image.uri) || undefined,
    }));

  const sendWithLocal = async (history) => {
    dispatch(beginAssistantMessage(currentId));
    const run = (items) =>
      complete(items, {
        temperature: local.params.temperature,
        topP: local.params.topP,
        maxTokens: local.params.maxTokens,
        systemPrompt: local.params.systemPrompt,
        onToken: (partial) => dispatch(updateAssistantMessage({ id: currentId, content: partial })),
      });

    try {
      let text;
      try {
        text = await run(history);
      } catch (firstFailure) {
        // some builds refuse file paths - retry once with an inline data URL
        const needsRetry =
          photo && /image|media|mtmd|open|load|path/i.test(String(firstFailure && firstFailure.message));
        if (!needsRetry) throw firstFailure;
        const dataUrl = await toDataUrl(photo.uri);
        text = await run(
          history.map((message) => ({
            ...message,
            imageUrl: toChatMessages([message])[0].content === message.content ? message.imageUrl : dataUrl,
          }))
        );
      }
      dispatch(updateAssistantMessage({ id: currentId, content: text || "(no answer)" }));
      if (speech.settings.autoSpeak) dispatch(speakText(text || ""));
    } catch (failure) {
      dispatch(dropEmptyAssistantMessage(currentId));
      dispatch(setError((failure && failure.message) || "Local model error"));
    }
  };

  // Dictation: tap the mic to start, tap again to stop; hold it to talk and
  // release to stop (push to talk). The transcript lands in the message box.
  const holdTimer = useRef(null);
  const holdingRef = useRef(false);
  const handledRef = useRef(false);

  const beginDictation = async () => {
    handledRef.current = true;
    try {
      await dispatch(startDictation()).unwrap();
    } catch (failure) {
      handledRef.current = false;
      Alert.alert(
        "Dictation",
        `${String((failure && failure.message) || failure)}\n\nThe first tap downloads the speech model automatically (about 57 MB); after that dictation is fully offline.`
      );
    }
  };

  const endDictation = async () => {
    try {
      const result = await dispatch(stopDictation()).unwrap();
      const text = (result && result.text) || "";
      if (!text) {
        if (result && result.frames) {
          Alert.alert("Dictation", "Nothing recognisable in that clip - try again, a little closer to the mic.");
        }
        return;
      }
      if (dictation.settings.autoSend) {
        setInput(text);
        await onSend(text);
      } else {
        setInput((previous) => (previous.trim() ? `${previous.trim()} ${text}` : text));
      }
    } catch (failure) {
      Alert.alert("Dictation", String((failure && failure.message) || failure));
    }
  };

  const onMicPressIn = () => {
    handledRef.current = false;
    holdingRef.current = false;
    if (dictation.status !== "idle") return;
    holdTimer.current = setTimeout(() => {
      holdingRef.current = true;
      beginDictation();
    }, 350);
  };

  const onMicPressOut = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    if (holdingRef.current) {
      holdingRef.current = false;
      endDictation();
    }
  };

  const onMicPress = () => {
    // A hold already opened and closed the recording; do not toggle again.
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    if (dictation.status === "recording") endDictation();
    else if (dictation.status === "idle") beginDictation();
  };

  const onSend = async (override) => {
    const text = (typeof override === "string" ? override : input).trim();
    if ((!text && !photo) || !currentId || busy) return;
    if (!canSend) {
      dispatch(setError("Load a local model on the Model tab first, or switch to API mode."));
      return;
    }

    const attached = photo;
    setInput("");
    setPhoto(null);
    dispatch(clearError());
    dispatch(addUserMessage({ id: currentId, content: text, image: attached }));

    // resolve the photo for the chosen backend
    let imageUrl = attached ? attached.uri : undefined;
    if (attached && mode === "api") {
      try {
        imageUrl = await toDataUrl(attached.uri);
      } catch (failure) {
        imageUrl = attached.uri;
      }
    }

    const history = outgoingHistory(imageUrl);

    setBusy(true);
    try {
      if (mode === "local") {
        await sendWithLocal(history);
      } else {
        await dispatch(sendMessage({ conversationId: currentId, messages: history })).unwrap();
      }
    } catch (failure) {
      // the error text lives in the store
    } finally {
      setBusy(false);
    }
  };

  const copyMessage = async (index, content) => {
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopiedId(index);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const working = busy || status === "loading";
  const activeTemp = mode === "local" ? local.params.temperature : settings.temperature;
  const activeMax = mode === "local" ? local.params.maxTokens : settings.maxTokens;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeButton, mode === "api" && styles.modeButtonActive]}
          onPress={() => dispatch(setMode("api"))}
        >
          <Text style={[styles.modeText, mode === "api" && styles.modeTextActive]}>API</Text>
          <Text style={[styles.modeSub, mode === "api" && styles.modeTextActive]} numberOfLines={1}>
            {settings.model || "model"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeButton, mode === "local" && styles.modeButtonActive]}
          onPress={() => dispatch(setMode("local"))}
        >
          <Text style={[styles.modeText, mode === "local" && styles.modeTextActive]}>On-device</Text>
          <Text style={[styles.modeSub, mode === "local" && styles.modeTextActive]} numberOfLines={1}>
            {localReady
              ? `${local.params.nCtx} ctx / ${local.vision ? "photos" : "text"}`
              : "not loaded"}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, index) => `${index}-${item.role}`}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current && listRef.current.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Start chatting</Text>
            <Text style={styles.emptyText}>
              {mode === "api"
                ? `API mode: ${settings.model} @ ${settings.baseUrl}`
                : localReady
                ? `On-device: ${local.name}${local.vision ? " (photos enabled)" : " (text only)"}`
                : "On-device: load a GGUF model on the Model tab"}
            </Text>
            <Text style={styles.emptyHint}>
              Tap the photo button to send an image with your question.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const isUser = item.role === "user";
          const imageUri = item.image && item.image.uri;
          return (
            <View style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
              <TouchableOpacity
                activeOpacity={0.9}
                onLongPress={() => copyMessage(index, item.content)}
                style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
              >
                {imageUri ? (
                  <Image source={{ uri: imageUri }} style={styles.bubbleImage} resizeMode="cover" />
                ) : null}
                {item.content ? (
                  <Text style={isUser ? styles.userText : styles.assistantText}>{item.content}</Text>
                ) : imageUri ? null : (
                  <Text style={isUser ? styles.userText : styles.assistantText}>...</Text>
                )}
                <View style={styles.bubbleMeta}>
                  <Text style={[styles.bubbleTime, isUser && styles.bubbleTimeUser]}>
                    {copiedId === index ? "copied" : formatTime(item.ts)}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        }}
      />

      {working ? (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>
            {mode === "local"
              ? photo || messages.some((message) => message.image)
                ? "Reading the photo on device..."
                : "Generating on device..."
              : "Waiting for the API..."}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorWrap}>
          <Banner
            tone="danger"
            title="Error"
            text={String(error)}
            actionLabel="Hide"
            onAction={() => dispatch(clearError())}
          />
        </View>
      ) : null}

      {photo ? (
        <View style={styles.photoStrip}>
          <Image source={{ uri: photo.uri }} style={styles.photoThumb} resizeMode="cover" />
          <View style={{ flex: 1 }}>
            <Text style={styles.photoTitle}>Photo ready</Text>
            <Text style={styles.photoHint} numberOfLines={2}>
              {photo.width && photo.height ? `${photo.width} x ${photo.height}` : "image"} - add a
              question or just send it.
            </Text>
          </View>
          <TouchableOpacity onPress={clearPhoto} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.photoRemove}>Remove</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {dictation.status !== "idle" ? (
        <View style={styles.dictationStrip}>
          <View style={styles.dictationDot} />
          <View style={{ flex: 1 }}>
            <Text style={styles.dictationTitle}>
              {dictation.status === "recording"
                ? `Listening ${dictation.seconds.toFixed(1)}s - release or tap Mic to stop`
                : dictation.status === "preparing"
                ? dictation.downloading
                  ? `Getting the dictation model - ${Math.round((dictation.progress || 0) * 100)}%`
                  : "Getting dictation ready..."
                : "Transcribing on this phone..."}
            </Text>
            <Text style={styles.dictationText} numberOfLines={2}>
              {dictation.liveText ||
                (dictation.status === "preparing"
                  ? "First use downloads the speech model once (about 57 MB), then dictation is fully offline."
                  : "Speak normally; the text lands in the box below.")}
            </Text>
          </View>
          <TouchableOpacity onPress={() => dispatch(cancelDictation())}>
            <Text style={styles.dictationCancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.inputRow}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={attachPhoto}
          disabled={busy}
          accessibilityLabel="Attach a photo"
        >
          <Text style={styles.attachIcon}>Photo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.micButton,
            dictation.status === "recording" && styles.micButtonActive,
            dictation.status === "transcribing" && styles.micButtonBusy,
          ]}
          onPressIn={onMicPressIn}
          onPressOut={onMicPressOut}
          onPress={onMicPress}
          disabled={dictation.status === "transcribing" || busy}
          accessibilityLabel="Dictate: tap to start or stop, hold to talk"
        >
          {dictation.status === "transcribing" ? (
            <ActivityIndicator color={colors.onPrimary} size="small" />
          ) : (
            <Text style={[styles.micIcon, dictation.status === "recording" && styles.micIconActive]}>
              {dictation.status === "recording" ? "STOP" : "Mic"}
            </Text>
          )}
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder={photo ? "Ask about this photo..." : "Type a message..."}
          placeholderTextColor={colors.muted}
          value={input}
          onChangeText={setInput}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, working && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={working}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.stripRow}>
        <Pill label={`temp ${activeTemp}`} tone="default" />
        <Pill label={`max ${activeMax}`} tone="default" />
        <Pill
          label={mode === "local" ? (local.vision ? "CPU + vision" : "CPU") : "HTTPS"}
          tone={mode === "local" ? (local.vision ? "success" : "info") : "success"}
        />
        {conversation ? (
          <TouchableOpacity style={styles.stripDelete} onPress={() => dispatch(deleteConversation(currentId))}>
            <Text style={styles.stripDeleteText}>Delete chat</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  modeRow: {
    flexDirection: "row",
    padding: spacing(3),
    gap: spacing(2),
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modeButton: {
    flex: 1,
    paddingVertical: spacing(2.5),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
  },
  modeButtonActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeText: { color: colors.text, fontWeight: "700", fontSize: font(14) },
  modeSub: { fontSize: font(11), color: colors.muted, marginTop: 2, maxWidth: "95%" },
  modeTextActive: { color: colors.onPrimary },
  list: { padding: spacing(4), flexGrow: 1 },
  empty: { alignItems: "center", paddingTop: spacing(16), paddingHorizontal: spacing(6) },
  emptyTitle: { fontSize: font(17), fontWeight: "800", color: colors.text },
  emptyText: { ...typography.small, textAlign: "center", marginTop: spacing(2), lineHeight: 18 },
  emptyHint: { ...typography.small, textAlign: "center", marginTop: spacing(3), color: colors.primary },
  bubbleRow: { flexDirection: "row", marginVertical: spacing(1.5) },
  rowRight: { justifyContent: "flex-end" },
  rowLeft: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    borderRadius: radius.lg,
  },
  bubbleImage: {
    width: 200,
    height: 200,
    borderRadius: radius.md,
    marginBottom: spacing(2),
    backgroundColor: colors.surfaceHigh,
  },
  userBubble: { backgroundColor: colors.userBubble, borderBottomRightRadius: 6 },
  assistantBubble: {
    backgroundColor: colors.assistantBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderBottomLeftRadius: 6,
    ...shadow.card,
  },
  userText: { color: colors.userText, fontSize: font(15.5), lineHeight: 22, fontWeight: "500" },
  assistantText: { color: colors.assistantText, fontSize: font(15.5), lineHeight: 22 },
  bubbleMeta: { flexDirection: "row", justifyContent: "flex-end", marginTop: spacing(1.5) },
  bubbleTime: { fontSize: font(10.5), color: colors.muted },
  bubbleTimeUser: { color: "rgba(4,20,10,0.55)" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing(4),
    paddingBottom: spacing(2),
  },
  statusText: { marginLeft: spacing(2), color: colors.muted, fontSize: font(12.5) },
  errorWrap: { paddingHorizontal: spacing(4) },
  photoStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing(3),
    marginHorizontal: spacing(3),
    marginBottom: spacing(1),
    padding: spacing(2.5),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  photoThumb: { width: 46, height: 46, borderRadius: radius.sm, backgroundColor: colors.surfaceHigh },
  photoTitle: { fontSize: font(13.5), fontWeight: "700", color: colors.text },
  photoHint: { ...typography.small, marginTop: 1 },
  photoRemove: { color: colors.danger, fontWeight: "700", fontSize: font(12.5) },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: spacing(3),
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  attachButton: {
    height: 44,
    paddingHorizontal: spacing(3.5),
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    marginRight: spacing(2),
  },
  attachIcon: { color: colors.primary, fontWeight: "800", fontSize: font(12.5) },
  micButton: {
    minWidth: 54,
    paddingHorizontal: spacing(2.5),
    paddingVertical: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonActive: { backgroundColor: colors.danger, borderColor: colors.danger },
  micButtonBusy: { opacity: 0.7 },
  micIcon: { color: colors.primary, fontWeight: "800", fontSize: font(12.5) },
  micIconActive: { color: colors.onPrimary },
  dictationStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing(2.5),
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
    marginBottom: spacing(2),
  },
  dictationDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
  dictationTitle: { color: colors.text, fontWeight: "700", fontSize: font(12.5) },
  dictationText: { ...typography.small, marginTop: spacing(0.5) },
  dictationCancel: { color: colors.danger, fontWeight: "700", fontSize: font(12.5) },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 130,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2.5),
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    fontSize: font(15),
  },
  sendButton: {
    marginLeft: spacing(2),
    backgroundColor: colors.primary,
    paddingHorizontal: spacing(5),
    paddingVertical: spacing(3.2),
    borderRadius: radius.lg,
  },
  sendButtonDisabled: { backgroundColor: colors.primaryDisabled },
  sendText: { color: colors.onPrimary, fontWeight: "700" },
  stripRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing(2),
    paddingHorizontal: spacing(3),
    paddingBottom: spacing(2.5),
    backgroundColor: colors.surface,
  },
  stripDelete: { marginLeft: "auto" },
  stripDeleteText: { color: colors.danger, fontSize: font(12.5), fontWeight: "700" },
});
