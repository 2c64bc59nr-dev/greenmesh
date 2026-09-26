import React, { useEffect, useState } from "react";
import { View, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import {
  downloadLocalModel,
  downloadModelPreset,
  loadLocalModel,
  unloadLocalModel,
  refreshLocalModels,
  deleteLocalModel,
  updateLocalParams,
  clearLocalError,
  setLocalProjector,
  clearMultimodalError,
} from "../features/chat/chatSlice";
import { freeSpace, formatBytes } from "../local/modelStore";
import { Text, Card, SectionTitle, Button, Field, Bar, Pill, Stepper, Banner } from "../components/ui";
import { colors, spacing, font, radius, type as typography } from "../theme";

const GB = 1024 * 1024 * 1024;

/**
 * Downloads. `bytes` is model + projector and is used to warn when a preset
 * cannot fit in the phone's free storage.
 *
 * Only families the bundled llama.cpp actually implements are listed: Qwen VL
 * (Qwen2-VL / Qwen2.5-VL / Qwen3-VL), InternVL for photos, then plain text
 * Qwen3 / LFM2 / Nemotron. Gemma 3n is deliberately absent - it has no vision
 * projector upstream, so photos are impossible on it.
 */
const VISION_PRESETS = [
  {
    label: "InternVL3 1B",
    detail: "0.63 GB + 0.31 GB projector - smallest photo model that exists",
    ram: "needs ~2.5 GB free RAM",
    bytes: Math.round(0.94 * GB),
    url: "https://huggingface.co/ggml-org/InternVL3-1B-Instruct-GGUF/resolve/main/InternVL3-1B-Instruct-Q8_0.gguf",
    mmprojUrl:
      "https://huggingface.co/ggml-org/InternVL3-1B-Instruct-GGUF/resolve/main/mmproj-InternVL3-1B-Instruct-Q8_0.gguf",
  },
  {
    label: "Qwen3-VL 2B",
    detail: "1.03 GB + 0.41 GB projector - newest generation, small",
    ram: "needs ~3 GB free RAM",
    bytes: Math.round(1.45 * GB),
    url: "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3VL-2B-Instruct-Q4_K_M.gguf",
    mmprojUrl:
      "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
  },
  {
    label: "Qwen2-VL 2B",
    detail: "0.92 GB + 0.66 GB projector - older generation, well tested",
    ram: "needs ~3 GB free RAM",
    bytes: Math.round(1.58 * GB),
    url: "https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/main/Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
    mmprojUrl:
      "https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf",
  },
  {
    label: "Qwen2.5-VL 3B",
    detail: "1.76 GB + 0.77 GB projector - best photo quality per byte",
    ram: "needs ~4.5 GB free RAM",
    bytes: Math.round(2.53 * GB),
    url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
    mmprojUrl:
      "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
  },
  {
    label: "Qwen3-VL 4B",
    detail: "2.27 GB + 0.41 GB projector - more detail, slower on CPU",
    ram: "needs ~6 GB free RAM",
    bytes: Math.round(2.68 * GB),
    url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf",
    mmprojUrl:
      "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
  },
  {
    label: "Qwen2.5-VL 7B",
    detail: "4.36 GB + 0.78 GB projector - desktop-class, will struggle on a phone",
    ram: "needs ~8 GB free RAM",
    bytes: Math.round(5.14 * GB),
    url: "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    mmprojUrl:
      "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf",
  },
];

const TEXT_PRESETS = [
  {
    label: "Qwen3 0.6B",
    detail: "0.36 GB - newest tiny Qwen, fastest on CPU",
    ram: "runs anywhere",
    bytes: Math.round(0.36 * GB),
    url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
  },
  {
    label: "LFM2.5 1.2B Instruct",
    detail: "0.71 GB - the model currently loaded, good chat quality",
    ram: "runs on low-RAM phones",
    bytes: Math.round(0.71 * GB),
    url: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
  },
  {
    label: "Qwen3 1.7B",
    detail: "1.03 GB - stronger reasoning, still comfortable",
    ram: "needs ~2 GB free RAM",
    bytes: Math.round(1.03 * GB),
    url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
  },
  {
    label: "Qwen3 4B",
    detail: "2.27 GB - solid general chat, slow on a phone CPU",
    ram: "needs ~4 GB free RAM",
    bytes: Math.round(2.27 * GB),
    url: "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
  },
  {
    label: "Nemotron Nano 4B v1.1",
    detail: "2.53 GB - newest small NVIDIA Nemotron (Llama-3.1-Nemotron-Nano-4B)",
    ram: "needs ~4.5 GB free RAM",
    bytes: Math.round(2.53 * GB),
    url: "https://huggingface.co/lmstudio-community/Llama-3.1-Nemotron-Nano-4B-v1.1-GGUF/resolve/main/Llama-3.1-Nemotron-Nano-4B-v1.1-Q4_K_M.gguf",
  },
  {
    label: "Nemotron Mini 4B Instruct",
    detail: "2.45 GB - earlier NVIDIA Nemotron 4B, chat tuned",
    ram: "needs ~4.5 GB free RAM",
    bytes: Math.round(2.45 * GB),
    url: "https://huggingface.co/bartowski/Nemotron-Mini-4B-Instruct-GGUF/resolve/main/Nemotron-Mini-4B-Instruct-Q4_K_M.gguf",
  },
];

const CTX_OPTIONS = [512, 1024, 2048, 4096, 8192];

export default function LocalModelPage() {
  const dispatch = useDispatch();
  const local = useSelector((state) => state.chat.local);
  const [url, setUrl] = useState("");
  const [paramsDirty, setParamsDirty] = useState(false);
  const [free, setFree] = useState(null);

  const refreshFree = () => {
    freeSpace()
      .then((value) => setFree(value))
      .catch(() => setFree(null));
  };

  useEffect(() => {
    dispatch(refreshLocalModels());
    refreshFree();
  }, [dispatch]);

  // Sampling parameters are applied per completion; only the context size and the
  // thread count require reloading the model.
  const setParam = (patch, requiresReload = false) => {
    dispatch(updateLocalParams(patch));
    if (requiresReload) setParamsDirty(true);
  };

  const [repo, setRepo] = useState("");
  const [repoFile, setRepoFile] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState(null);

  // Any Hugging Face GGUF repository, not just the shortcuts listed above. Give
  // owner/name and the app picks a sensibly-sized quantisation from that repo's own
  // file list, or name the file yourself. It then uses exactly the same download
  // path the presets use, so behaviour is identical.
  const downloadFromRepo = async () => {
    const clean = String(repo || "")
      .trim()
      .replace(/^https?:\/\/huggingface\.co\//, "")
      .replace(/\/+$/, "");
    if (!clean || local.downloading || repoBusy) return;
    let file = String(repoFile || "").trim();
    setRepoError(null);
    try {
      setRepoBusy(true);
      if (!file) {
        const response = await fetch(`https://huggingface.co/api/models/${clean}`);
        if (!response.ok) throw new Error(`repository not found (${response.status})`);
        const data = await response.json();
        const files = (data.siblings || [])
          .map((entry) => entry.rfilename)
          .filter((name) => /\.gguf$/i.test(name));
        if (!files.length) throw new Error("that repository contains no .gguf file");
        const order = ["q4_k_m", "q4_k_s", "q5_k_m", "q4_0", "q8_0"];
        file = order.map((q) => files.find((f) => f.toLowerCase().includes(q))).find(Boolean) || files[0];
      }
      setRepoBusy(false);
      download(`https://huggingface.co/${clean}/resolve/main/${file}`);
    } catch (error) {
      setRepoBusy(false);
      setRepoError(String((error && error.message) || error));
    }
  };

  const download = (target) => {
    const value = (target || url).trim();
    if (!value) return;
    dispatch(downloadLocalModel({ url: value })).then(() => {
      dispatch(refreshLocalModels());
      refreshFree();
    });
  };

  const downloadPreset = (preset) => {
    if (local.downloading) return;
    setUrl(preset.url);
    dispatch(downloadModelPreset({ url: preset.url, mmprojUrl: preset.mmprojUrl })).then(() => {
      dispatch(refreshLocalModels());
      refreshFree();
    });
  };

  const loadModel = (model) => {
    dispatch(
      loadLocalModel({
        path: model.path,
        name: model.name,
        mmprojPath: local.mmprojPath || undefined,
      })
    );
    setParamsDirty(false);
  };
  const ctxIndex = CTX_OPTIONS.indexOf(local.params.nCtx);
  // Defensive: a state blob persisted by an older build may lack the newer
  // projector fields, and a missing array must never crash the screen.
  const projectors = local.projectors || [];
  const models = local.models || [];
  const mmprojPath = local.mmprojPath || null;
  const selectedProjector = projectors.find((file) => file.path === mmprojPath);

  const renderPreset = (preset) => {
    const vision = Boolean(preset.mmprojUrl);
    const isLoaded =
      local.ready && local.path && String(local.path).endsWith(preset.url.split("/").pop());
    const tooBig = free !== null && preset.bytes && preset.bytes > free;
    return (
      <TouchableOpacity key={preset.url} style={styles.presetCard} onPress={() => downloadPreset(preset)}>
        <View style={{ flex: 1 }}>
          <View style={styles.presetTitleRow}>
            <Text style={styles.presetTitle}>{preset.label}</Text>
            {vision ? <Pill label="photos" tone="success" /> : null}
            {isLoaded ? <Pill label="loaded" tone="primary" /> : null}
            {tooBig ? <Pill label="won't fit now" tone="warn" /> : null}
          </View>
          <Text style={typography.small}>{preset.detail}</Text>
          <Text style={styles.presetRam}>{preset.ram}</Text>
        </View>
        <Pill label={local.downloading ? "..." : "Download"} tone="primary" />
      </TouchableOpacity>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionTitle right={local.ready ? "active" : undefined}>Loaded model</SectionTitle>
      {local.ready ? (
        <Card>
          <Text style={styles.modelName}>{local.name}</Text>
          <View style={styles.pillRow}>
            <Pill label="CPU" tone="info" />
            <Pill label={`ctx ${local.params.nCtx}`} tone="primary" />
            <Pill label={`${local.params.nThreads} threads`} tone="default" />
            <Pill
              label={local.vision ? "can see photos" : "text only"}
              tone={local.vision ? "success" : "warn"}
            />
          </View>
          {mmprojPath ? (
            <Text style={styles.mmprojLine} numberOfLines={2}>
              projector: {String(mmprojPath).split("/").pop()}
            </Text>
          ) : null}
          {local.multimodalError ? (
            <Banner
              tone="warn"
              title="Projector problem"
              text={String(local.multimodalError)}
              actionLabel="Hide"
              onAction={() => dispatch(clearMultimodalError())}
            />
          ) : null}
          <Button
            title="Unload model"
            variant="secondary"
            style={styles.cardButton}
            onPress={() => dispatch(unloadLocalModel())}
          />
        </Card>
      ) : local.loading ? (
        <Card>
          <Text style={styles.modelName}>Loading model...</Text>
          <Bar value={local.loadProgress} />
          <Text style={styles.progressText}>{Math.round((local.loadProgress || 0) * 100)}%</Text>
        </Card>
      ) : (
        <Card>
          <Text style={styles.muted}>No model loaded.</Text>
        </Card>
      )}

      <SectionTitle>On-device parameters</SectionTitle>
      <Card>
        <Stepper
          label="Context (n_ctx)"
          value={local.params.nCtx}
          min={CTX_OPTIONS[0]}
          max={CTX_OPTIONS[CTX_OPTIONS.length - 1]}
          step={512}
          onChange={(value) => setParam({ nCtx: value }, true)}
          format={(value) => `${value} tokens`}
        />
        <Stepper
          label="CPU threads (n_threads)"
          value={local.params.nThreads}
          min={1}
          max={8}
          onChange={(value) => setParam({ nThreads: value }, true)}
        />
        <Stepper
          label="Temperature"
          value={local.params.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(value) => setParam({ temperature: value })}
          format={(value) => value.toFixed(1)}
        />
        <Stepper
          label="Max response tokens"
          value={local.params.maxTokens}
          min={32}
          max={1024}
          step={32}
          onChange={(value) => setParam({ maxTokens: value })}
        />
        <Stepper
          label="Top-p"
          value={local.params.topP}
          min={0.1}
          max={1}
          step={0.05}
          onChange={(value) => setParam({ topP: value })}
          format={(value) => value.toFixed(2)}
        />
        <Field
          label="System prompt (on-device)"
          value={local.params.systemPrompt}
          onChangeText={(value) => setParam({ systemPrompt: value })}
          multiline
          style={styles.promptInput}
        />
        <Button
          title="Next context preset"
          variant="ghost"
          small
          style={styles.linkButton}
          onPress={() => setParam({ nCtx: CTX_OPTIONS[(ctxIndex + 1) % CTX_OPTIONS.length] }, true)}
        />
        {paramsDirty && local.ready ? (
          <Banner
            tone="warn"
            text="Context size or thread count changed - reload the model to apply it."
            actionLabel="Reload now"
            onAction={() => {
              dispatch(loadLocalModel({ path: local.path, name: local.name }));
              setParamsDirty(false);
            }}
          />
        ) : null}
      </Card>

      <SectionTitle right={free !== null ? `${formatBytes(free)} free` : undefined}>
        Vision models - can see photos
      </SectionTitle>
      {VISION_PRESETS.map(renderPreset)}
      <Text style={styles.footNote}>
        A vision model needs its projector (mmproj) file as well - tapping a preset downloads both and
        pre-selects the projector. Photos only work while a projector is loaded with the model.
      </Text>

      <SectionTitle>Text models - no photo input</SectionTitle>
      {TEXT_PRESETS.map(renderPreset)}

      <SectionTitle>Any model on Hugging Face</SectionTitle>
      <Card>
        <Field
          label="Repository (owner/name)"
          value={repo}
          onChangeText={setRepo}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="bartowski/Qwen2.5-7B-Instruct-GGUF"
        />
        <Field
          label="File inside the repository (optional)"
          value={repoFile}
          onChangeText={setRepoFile}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="leave empty to pick a quantisation automatically"
        />
        <Text style={styles.progressText}>
          The list above is a set of shortcuts, not a limit: any GGUF repository works,
          and so does any direct download URL below. Speech models the same way -
          Whisper GGML and Piper voices, wherever they are hosted.
        </Text>
        {repoError ? (
          <Text style={styles.progressText}>
            Could not use that repository: {repoError}
          </Text>
        ) : null}
        <Button
          title="Download from repository"
          style={styles.cardButton}
          loading={local.downloading || repoBusy}
          onPress={downloadFromRepo}
        />
      </Card>

      <Card>
        <Field
          label="Custom .gguf URL"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://.../model-Q4_K_M.gguf"
        />
        <Button
          title="Download from URL"
          style={styles.cardButton}
          loading={local.downloading}
          onPress={() => download()}
        />
        {local.downloading ? (
          <View>
            <Bar value={local.downloadProgress || 0} />
            <Text style={styles.progressText}>{Math.round((local.downloadProgress || 0) * 100)}%</Text>
          </View>
        ) : null}
        <Button
          title="Refresh storage / model list"
          variant="ghost"
          small
          style={styles.linkButton}
          onPress={() => {
            dispatch(refreshLocalModels());
            refreshFree();
          }}
        />
      </Card>

      <SectionTitle right={`${projectors.length}`}>Projectors (mmproj)</SectionTitle>
      {projectors.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            No projector on the phone yet. Photos need one - download a vision preset above.
          </Text>
        </Card>
      ) : (
        projectors.map((file) => (
          <Card key={file.path}>
            <Text style={styles.modelName}>{file.name}</Text>
            <View style={styles.pillRow}>
              <Pill label={file.sizeLabel} tone="default" />
              {mmprojPath === file.path ? <Pill label="selected" tone="success" /> : null}
            </View>
            <View style={styles.buttonRow}>
              <Button
                title={mmprojPath === file.path ? "Deselect" : "Use for photos"}
                small
                variant={mmprojPath === file.path ? "secondary" : "primary"}
                style={styles.halfButton}
                onPress={() => dispatch(setLocalProjector(mmprojPath === file.path ? null : file.path))}
              />
              <Button
                title="Delete"
                small
                variant="danger"
                style={styles.halfButton}
                onPress={() => dispatch(deleteLocalModel({ path: file.path }))}
              />
            </View>
          </Card>
        ))
      )}
      {projectors.length > 0 && local.ready && !local.vision ? (
        <Banner
          tone="info"
          text={
            selectedProjector
              ? "A projector is selected - reload the model to switch photo input on."
              : "Reload the model with a projector selected to enable photo input."
          }
          actionLabel="Reload"
          onAction={() => dispatch(loadLocalModel({ path: local.path, name: local.name }))}
        />
      ) : null}

      <SectionTitle right={`${models.length}`}>Models on this phone</SectionTitle>
      {models.length === 0 ? (
        <Card>
          <Text style={styles.muted}>No models downloaded yet.</Text>
        </Card>
      ) : (
        models.map((model) => (
          <Card key={model.path}>
            <Text style={styles.modelName}>{model.name}</Text>
            <View style={styles.pillRow}>
              <Pill label={model.sizeLabel} tone="default" />
              {local.path === model.path && local.ready ? <Pill label="loaded" tone="success" /> : null}
            </View>
            <View style={styles.buttonRow}>
              <Button title="Load" small style={styles.halfButton} onPress={() => loadModel(model)} />
              <Button
                title="Delete"
                small
                variant="danger"
                style={styles.halfButton}
                onPress={() => dispatch(deleteLocalModel({ path: model.path }))}
              />
            </View>
          </Card>
        ))
      )}

      {local.error ? (
        <View style={styles.bannerWrap}>
          <Banner
            tone="danger"
            title="Local model error"
            text={String(local.error)}
            actionLabel="Hide"
            onAction={() => dispatch(clearLocalError())}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing(4), paddingBottom: spacing(10) },
  modelName: { fontSize: font(15.5), fontWeight: "700", color: colors.text },
  muted: { color: colors.muted },
  mmprojLine: { ...typography.small, marginTop: spacing(2) },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2), marginTop: spacing(2) },
  cardButton: { marginTop: spacing(3) },
  progressText: { ...typography.small, marginTop: spacing(1.5) },
  promptInput: { minHeight: 70, textAlignVertical: "top" },
  linkButton: { marginTop: spacing(2) },
  presetCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing(4),
    marginTop: spacing(2.5),
    gap: spacing(3),
  },
  presetTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing(2), marginBottom: 2 },
  presetTitle: { fontSize: font(15), fontWeight: "700", color: colors.text },
  presetRam: { fontSize: font(11.5), color: colors.primary, marginTop: 3, fontWeight: "600" },
  footNote: { ...typography.small, marginTop: spacing(3), lineHeight: 17 },
  buttonRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(3) },
  halfButton: { flex: 1 },
  bannerWrap: { marginTop: spacing(3) },
});
