import React, { useMemo, useState } from "react";
import { View, FlatList, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import {
  openConversation,
  newConversation,
  deleteConversation,
  clearAllConversations,
  exportChats,
  importChats,
} from "../features/chat/chatSlice";
import { Text, Screen, Field, Button, EmptyState, Pill } from "../components/ui";
import { colors, spacing, font, radius, shadow, type as typography } from "../theme";

const formatTime = (ts) =>
  ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export default function ConversationsPage({ onOpen }) {
  const dispatch = useDispatch();
  const { conversations, order } = useSelector((state) => state.chat);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const runExport = async (format) => {
    setBusy(format);
    setNote(null);
    try {
      const result = await dispatch(exportChats({ format })).unwrap();
      setNote(
        result.shared
          ? `Exported ${result.chats} chat(s) as ${result.name} and opened the share sheet.`
          : `Exported ${result.chats} chat(s) to ${result.uri}`
      );
    } catch (error) {
      Alert.alert("Export failed", String((error && error.message) || error));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setNote(null);
    try {
      const result = await dispatch(importChats()).unwrap();
      if (result.canceled) return;
      setNote(
        result.imported === 0
          ? `Nothing new in ${result.file} - all ${result.skipped} chat(s) are already here.`
          : `Imported ${result.imported} chat(s) from ${result.file} (${result.format}); ${result.skipped} already present.`
      );
    } catch (error) {
      Alert.alert("Import failed", String((error && error.message) || error));
    } finally {
      setBusy(null);
    }
  };

  const items = useMemo(() => {
    const all = order.map((id) => conversations[id]).filter(Boolean);
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(needle) ||
        conversation.messages.some((message) => message.content.toLowerCase().includes(needle))
    );
  }, [conversations, order, query]);

  const totalMessages = order.reduce(
    (total, id) => total + ((conversations[id] && conversations[id].messages.length) || 0),
    0
  );

  const open = (id) => {
    dispatch(openConversation(id));
    if (onOpen) onOpen();
  };

  const create = () => {
    dispatch(newConversation());
    if (onOpen) setTimeout(() => onOpen(), 0);
  };

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Button title="+ New chat" onPress={create} />
            <View style={styles.transferRow}>
              <TouchableOpacity
                style={[styles.transferChip, busy && styles.transferChipBusy]}
                onPress={() => runExport("jsonl")}
                disabled={Boolean(busy) || order.length === 0}
              >
                <Text style={styles.transferText}>
                  {busy === "jsonl" ? "Exporting..." : "Export .jsonl"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.transferChip, busy && styles.transferChipBusy]}
                onPress={() => runExport("md")}
                disabled={Boolean(busy) || order.length === 0}
              >
                <Text style={styles.transferText}>{busy === "md" ? "Exporting..." : "Export .md"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.transferChip, busy && styles.transferChipBusy]}
                onPress={runImport}
                disabled={Boolean(busy)}
              >
                <Text style={styles.transferText}>{busy === "import" ? "Importing..." : "Import"}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.transferHint}>
              JSON Lines - one chat per line with OpenAI-style messages, the format ChatGPT exports and
              fine-tuning tools read. Import also accepts a JSON array of chats, a bare messages array
              and ChatGPT's conversations.json.
            </Text>
            {note ? <Text style={styles.transferNote}>{note}</Text> : null}
            <Field
              value={query}
              onChangeText={setQuery}
              placeholder="Search chats..."
              placeholderTextColor={colors.muted}
              autoCorrect={false}
              style={styles.search}
            />
            {order.length > 0 ? (
              <View style={styles.statsRow}>
                <Pill label={`${order.length} chats`} tone="primary" />
                <Pill label={`${totalMessages} messages`} tone="default" />
                <TouchableOpacity
                  style={styles.clearButton}
                  onPress={() =>
                    Alert.alert("Clear chats", "Delete all saved chats?", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => dispatch(clearAllConversations()),
                      },
                    ])
                  }
                >
                  <Text style={styles.clearText}>Clear all</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={query ? "No results" : "No chats yet"}
            text={query ? "Try another keyword." : "Tap “New chat” above to start talking."}
          />
        }
        renderItem={({ item }) => {
          const last = item.messages[item.messages.length - 1];
          return (
            <View style={styles.row}>
              <TouchableOpacity style={styles.rowMain} onPress={() => open(item.id)}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
                </View>
                <Text style={styles.subtitle} numberOfLines={2}>
                  {last ? last.content || "..." : "Empty chat"}
                </Text>
                <View style={styles.metaLine}>
                  <Pill label={`${item.messages.length} msg`} tone="primary" />
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => dispatch(deleteConversation(item.id))}
              >
                <Text style={styles.deleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: spacing(4), paddingBottom: spacing(8) },
  search: { marginTop: spacing(3) },
  transferRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(3) },
  transferChip: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing(2.5),
    alignItems: "center",
  },
  transferChipBusy: { opacity: 0.6 },
  transferText: { color: colors.text, fontWeight: "700", fontSize: font(13) },
  transferHint: { ...typography.small, marginTop: spacing(2) },
  transferNote: { color: colors.primary, fontSize: font(12.5), marginTop: spacing(2) },
  statsRow: { flexDirection: "row", alignItems: "center", gap: spacing(2), marginTop: spacing(3) },
  clearButton: { marginLeft: "auto" },
  clearText: { color: colors.danger, fontWeight: "700", fontSize: font(13) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginTop: spacing(3),
    paddingLeft: spacing(4),
    ...shadow.card,
  },
  rowMain: { flex: 1, paddingVertical: spacing(3.5) },
  rowTitleLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: font(15.5), fontWeight: "700", color: colors.text, flex: 1, marginRight: spacing(2) },
  time: { ...typography.small, marginRight: spacing(3) },
  subtitle: { ...typography.small, marginTop: spacing(1) },
  metaLine: { flexDirection: "row", marginTop: spacing(2) },
  deleteButton: { paddingHorizontal: spacing(4), paddingVertical: spacing(4) },
  deleteText: { color: colors.danger, fontWeight: "700", fontSize: font(13) },
});
