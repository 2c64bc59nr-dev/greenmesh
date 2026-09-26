import React, { useEffect, useState } from "react";
import { View, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import {
  scanNodes,
  refreshNodeHealth,
  addNode,
  removeNode,
  clearNodes,
  runRoutedJob,
  runBatch,
  setPolicy,
  setCoordinator,
  setRouterPort,
  clearRouterLog,
  clearRouterError,
  installRouterHandler,
  uninstallRouterHandler,
  runPlannedJob,
  setPlanMode,
  clearPlan,
  setAutoDiscover,
  runAgentTask,
  clearAgent,
} from "../features/router/routerSlice";
import { POLICIES } from "../router/jobRouter";
import { COMMON_PORTS } from "../router/nodeRegistry";
import { DEFAULT_API_KEY } from "../config";
import { Text, Card, SectionTitle, Button, Field, Bar, Pill, Banner } from "../components/ui";
import { colors, spacing, font, radius, type as typography } from "../theme";

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

export default function RouterPage() {
  const dispatch = useDispatch();
  const router = useSelector((state) => state.router);
  const serverState = useSelector((state) => state.chat.server);
  const local = useSelector((state) => state.chat.local);

  const [manual, setManual] = useState({ ip: "", port: "8080", apiKey: DEFAULT_API_KEY });
  const [job, setJob] = useState("");
  const [goal, setGoal] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [batchText, setBatchText] = useState("");

  useEffect(() => {
    if (router.coordinator) dispatch(installRouterHandler());
    else dispatch(uninstallRouterHandler());
  }, [dispatch, router.coordinator]);

  // Probe the remembered phones once on open, so a stale "unreachable" from the
  // last session never blocks routing.
  useEffect(() => {
    if (router.nodes && router.nodes.length) dispatch(refreshNodeHealth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Automation: while this phone coordinates, re-sweep the Wi-Fi on a timer so a
  // phone (or any other local AI server) that just came online joins by itself.
  useEffect(() => {
    if (!router.coordinator || !router.autoDiscover) return undefined;
    const seconds = Math.max(60, router.scanEverySec || 180);
    const timer = setInterval(() => dispatch(scanNodes({ deep: false })), seconds * 1000);
    return () => clearInterval(timer);
  }, [dispatch, router.coordinator, router.autoDiscover, router.scanEverySec]);

  const toggleCoordinator = () => {
    const next = !router.coordinator;
    dispatch(setCoordinator(next));
    if (next) dispatch(installRouterHandler());
    else dispatch(uninstallRouterHandler());
  };

  const nodes = router.nodes || [];
  const selectedPolicy = POLICIES.find((entry) => entry.key === router.policy) || POLICIES[0];
  const scanning = router.scanning;

  const runJob = () => {
    const prompt = job.trim();
    if (!prompt) return;
    dispatch(runRoutedJob({ prompt }));
  };

  const runBatchNow = () => {
    const prompts = batchText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!prompts.length) return;
    dispatch(runBatch({ prompts }));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionTitle right={router.coordinator ? "on" : "off"}>Coordinator</SectionTitle>
      <Card>
        <Text style={styles.title}>
          {router.coordinator ? "This phone routes the jobs" : "This phone runs its own jobs"}
        </Text>
        <Text style={styles.body}>
          As a coordinator this phone keeps the list of workers and sends each request to the phone
          that should run it. Clients point at this phone only - it answers like any OpenAI endpoint
          and dispatches behind the scenes.
        </Text>
        <View style={styles.pillRow}>
          <Pill
            label={serverState.running ? `server on :${serverState.port}` : "server stopped"}
            tone={serverState.running ? "success" : "warn"}
          />
          <Pill
            label={local.ready ? `local model: ${local.name}` : "no local model"}
            tone={local.ready ? "primary" : "default"}
          />
          <Pill label={`${nodes.length} node(s)`} tone="info" />
        </View>
        <Button
          title={router.coordinator ? "Turn coordinator off" : "Turn coordinator on"}
          variant={router.coordinator ? "secondary" : "primary"}
          style={styles.cardButton}
          onPress={toggleCoordinator}
        />
        {!serverState.running ? (
          <Banner
            tone="warn"
            text="The coordinator still needs its own server running (Server tab) so other phones and clients can reach it."
          />
        ) : null}
      </Card>

      <SectionTitle right={router.planMode ? "on" : "off"}>Planner mode</SectionTitle>
      <Card>
        <Text style={styles.title}>
          {router.planMode
            ? "This phone plans, the nodes execute"
            : "Requests are routed whole"}
        </Text>
        <Text style={styles.body}>
          With planner mode on, the model on this phone breaks every incoming request into steps. Each
          step is sent to a worker with a system prompt that tells it the mesh goal, which step it owns
          and which earlier results it must build on. This phone then merges the partial answers.
        </Text>
        <Button
          title={router.planMode ? "Turn planner mode off" : "Turn planner mode on"}
          variant={router.planMode ? "secondary" : "primary"}
          style={styles.cardButton}
          loading={router.planning}
          onPress={() => dispatch(setPlanMode(!router.planMode))}
        />
        {router.planMode && !local.ready ? (
          <Banner
            tone="warn"
            text="Planner mode needs a local model on this phone - without one the job cannot be split."
          />
        ) : null}
      </Card>

      <SectionTitle>Routing policy</SectionTitle>
      {POLICIES.map((entry) => {
        const active = entry.key === router.policy;
        return (
          <TouchableOpacity
            key={entry.key}
            style={[styles.policyCard, active && styles.policyCardActive]}
            onPress={() => dispatch(setPolicy(entry.key))}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.policyTitleRow}>
                <Text style={styles.title}>{entry.label}</Text>
                {active ? <Pill label="active" tone="success" /> : null}
              </View>
              <Text style={typography.small}>{entry.detail}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      {selectedPolicy.key === "smart" && !local.ready ? (
        <Banner
          tone="warn"
          text="The model-driven policy needs a local model loaded on this phone (Model tab) - until then the router falls back to least-busy."
        />
      ) : null}

      <SectionTitle right={`${nodes.length}`}>Phones and servers in the mesh</SectionTitle>
      <Card>
        <View style={styles.row}>
          <Button
            title={scanning ? "Scanning..." : "Scan my Wi-Fi"}
            loading={scanning}
            style={styles.flexButton}
            onPress={() => dispatch(scanNodes({}))}
          />
          <Button
            title="Deep scan"
            variant="secondary"
            style={styles.flexButton}
            onPress={() => dispatch(scanNodes({ deep: true }))}
          />
        </View>
        <View style={styles.row}>
          <Button
            title="Refresh health"
            variant="secondary"
            style={styles.flexButton}
            onPress={() => dispatch(refreshNodeHealth())}
          />
          <Button
            title={router.autoDiscover ? "auto-add: on" : "auto-add: off"}
            variant={router.autoDiscover ? "primary" : "secondary"}
            style={styles.flexButton}
            onPress={() => dispatch(setAutoDiscover(!router.autoDiscover))}
          />
        </View>
        {scanning ? (
          <View>
            <Bar value={router.scanProgress.total ? router.scanProgress.done / router.scanProgress.total : 0} />
            <Text style={styles.progressText}>
              {router.scanProgress.done}/{router.scanProgress.total} addresses probed
            </Text>
          </View>
        ) : null}
        <Text style={styles.hint}>
          Any machine on this Wi-Fi speaking the OpenAI API becomes a worker: the quick scan checks the
          mesh port {router.port}, the deep scan also tries {COMMON_PORTS.join(", ")} where Ollama, LM Studio
          and llama.cpp usually listen. A server is only added when it identifies itself on /models AND
          answers a real completion. With auto-add on, this repeats every {router.scanEverySec}s while
          coordinating{router.lastScan ? ` - last sweep ${time(router.lastScan)}` : ""}.
        </Text>
      </Card>

      {nodes.length === 0 ? (
        <Card>
          <Text style={styles.body}>
            No nodes known yet. Run "Scan my Wi-Fi" - the first find is usually this phone itself.
          </Text>
        </Card>
      ) : (
        nodes.map((node) => (
          <Card key={node.id}>
            <View style={styles.policyTitleRow}>
              <Text style={styles.title}>
                {node.self ? "this phone" : `${node.ip}`}
                <Text style={styles.mono}> :{node.port}</Text>
              </Text>
              <Pill
                label={node.ok ? `ok ${node.latencyMs || 0} ms` : "unreachable"}
                tone={node.ok ? "success" : "danger"}
              />
            </View>
            <View style={styles.pillRow}>
              <Pill
                label={node.kind === "openai" ? "openai server" : "greenmesh app"}
                tone={node.kind === "openai" ? "info" : "default"}
              />
              <Pill label={node.model || "no model loaded"} tone={node.model ? "primary" : "default"} />
              <Pill
                label={node.verified ? "verified 👍" : "unverified"}
                tone={node.verified ? "success" : "warn"}
              />
              {node.vision ? <Pill label="photos" tone="info" /> : null}
              <Pill label={`${node.jobs || 0} jobs`} tone="default" />
              {node.failures ? <Pill label={`${node.failures} failed`} tone="danger" /> : null}
              {node.self ? <Pill label="self" tone="info" /> : null}
            </View>
            {node.baseUrl ? <Text style={styles.hint}>{node.baseUrl}</Text> : null}
            {node.lastError && !node.ok ? <Text style={styles.error}>{node.lastError}</Text> : null}
            {!node.self ? (
              <View style={styles.row}>
                <Button
                  title="Remove"
                  variant="danger"
                  small
                  style={styles.flexButton}
                  onPress={() => dispatch(removeNode(node.id))}
                />
              </View>
            ) : null}
          </Card>
        ))
      )}

      <Card>
        <Field
          label="Add a phone by address"
          value={manual.ip}
          onChangeText={(value) => setManual({ ...manual, ip: value })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="192.168.1.42"
        />
        <Field
          label="Port"
          value={manual.port}
          onChangeText={(value) => setManual({ ...manual, port: value })}
          keyboardType="number-pad"
        />
        <Field
          label="Its API key (only if that phone requires one)"
          value={manual.apiKey}
          onChangeText={(value) => setManual({ ...manual, apiKey: value })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="optional"
        />
        <View style={styles.row}>
          <Button
            title="Add node"
            style={styles.flexButton}
            onPress={() => {
              if (!manual.ip.trim()) return;
              dispatch(
                addNode({
                  ip: manual.ip.trim(),
                  port: parseInt(manual.port, 10) || router.port,
                  apiKey: manual.apiKey.trim(),
                })
              );
            }}
          />
          <Button
            title="Forget all"
            variant="secondary"
            style={styles.flexButton}
            onPress={() => dispatch(clearNodes())}
          />
        </View>
      </Card>

      <SectionTitle>Ask the coordinator (the model uses tools)</SectionTitle>
      <Card>
        <Text style={styles.body}>
          The model on this phone picks tool calls by itself - scanning the network, adding a worker,
          sending a job, planning it across nodes. Every action it takes is listed below.
        </Text>
        <Field
          label="Task"
          value={agentInput}
          onChangeText={setAgentInput}
          multiline
          style={styles.jobInput}
          placeholder="Find every AI server on this Wi-Fi, add the working ones, then summarise what you found."
        />
        <Button
          title="Let the model do it"
          style={styles.cardButton}
          loading={router.agentRunning}
          onPress={() => dispatch(runAgentTask({ instruction: agentInput }))}
        />
        <View style={styles.row}>
          {[
            "Find and add all AI servers on this Wi-Fi.",
            "Check every worker and tell me which ones are slow.",
            "Plan a two-step answer about solar panels and run it.",
          ].map((recipe) => (
            <Button
              key={recipe}
              title={recipe.slice(0, 22)}
              variant="secondary"
              small
              style={styles.flexButton}
              onPress={() => {
                setAgentInput(recipe);
                dispatch(runAgentTask({ instruction: recipe }));
              }}
            />
          ))}
        </View>
        {(router.agentTrace || []).map((record, index) => (
          <View key={`${index}-${record.tool}`} style={styles.answerBox}>
            <Text style={styles.answerMeta}>
              {index + 1}. {record.tool}
            </Text>
            <Text style={styles.stepInstruction}>{JSON.stringify(record.args || {})}</Text>
            <Text style={styles.answerText}>{record.result}</Text>
          </View>
        ))}
        {router.agentAnswer ? (
          <View style={styles.finalBox}>
            <Text style={styles.answerMeta}>agent answer</Text>
            <Text style={styles.answerText}>{router.agentAnswer}</Text>
          </View>
        ) : null}
        {router.agentTrace && router.agentTrace.length ? (
          <Button
            title="Clear agent trace"
            variant="ghost"
            small
            style={styles.linkButton}
            onPress={() => dispatch(clearAgent())}
          />
        ) : null}
      </Card>

      <SectionTitle>Plan a job across the mesh</SectionTitle>
      <Card>
        <Field
          label="Goal"
          value={goal}
          onChangeText={setGoal}
          multiline
          style={styles.jobInput}
          placeholder="Write a short guide to keeping a balcony garden alive in winter."
        />
        <Button
          title="Plan and dispatch"
          style={styles.cardButton}
          loading={router.planning}
          onPress={() => dispatch(runPlannedJob({ goal }))}
        />
        {router.planGoal ? (
          <Text style={styles.planGoalText}>goal: {router.planGoal}</Text>
        ) : null}
        {(router.plan || []).map((step) => (
          <View key={step.index} style={styles.answerBox}>
            <Text style={styles.answerMeta}>
              step {step.index + 1} - {step.title}
              {step.node ? ` -> ${step.node}` : ""}
              {step.ms ? ` (${step.ms} ms)` : ""}
              {step.error ? ` failed: ${step.error}` : ""}
            </Text>
            <Text style={styles.stepInstruction} numberOfLines={3}>
              {step.instruction}
            </Text>
            {step.text ? <Text style={styles.answerText}>{step.text}</Text> : null}
          </View>
        ))}
        {router.planFinal ? (
          <View style={styles.finalBox}>
            <Text style={styles.answerMeta}>merged answer</Text>
            <Text style={styles.answerText}>{router.planFinal}</Text>
          </View>
        ) : null}
        {router.plan ? (
          <Button
            title="Clear plan"
            variant="ghost"
            small
            style={styles.linkButton}
            onPress={() => dispatch(clearPlan())}
          />
        ) : null}
      </Card>

      <SectionTitle>Send a job through the router</SectionTitle>
      <Card>
        <Field
          label="Job"
          value={job}
          onChangeText={setJob}
          multiline
          style={styles.jobInput}
          placeholder="Explain in two sentences why the sky is blue."
        />
        <Button
          title="Route one job"
          style={styles.cardButton}
          loading={router.busy}
          onPress={runJob}
        />
        {router.lastJob ? (
          <View style={styles.answerBox}>
            <Text style={styles.answerMeta}>
              ran on {router.lastJob.node.self ? "this phone" : router.lastJob.node.ip} in{" "}
              {router.lastJob.ms} ms - decided by {router.lastJob.decidedBy}
            </Text>
            <Text style={styles.answerText}>{router.lastJob.text || "(empty)"}</Text>
          </View>
        ) : null}
      </Card>

      <Card>
        <Field
          label="Batch - one prompt per line (spread over the mesh)"
          value={batchText}
          onChangeText={setBatchText}
          multiline
          style={styles.jobInput}
          placeholder={"Summarise the news in one line.\nList three uses for a small local model."}
        />
        <Button title="Run batch" variant="secondary" style={styles.cardButton} loading={router.busy} onPress={runBatchNow} />
        {router.batch
          ? router.batch.map((row, index) => (
              <View key={`${index}-${row && row.node}`} style={styles.answerBox}>
                <Text style={styles.answerMeta}>
                  {index + 1}. {row && row.ok ? `ok on ${row.node}` : `failed on ${row && row.node}: ${row && row.error}`}
                </Text>
                <Text style={styles.answerText}>{(row && row.text) || "(no answer)"}</Text>
              </View>
            ))
          : null}
      </Card>

      <SectionTitle right={`${router.log.length}`}>Router log</SectionTitle>
      <Card>
        {router.log.length === 0 ? (
          <Text style={styles.hint}>Nothing routed yet.</Text>
        ) : (
          router.log.map((entry, index) => (
            <View key={`${entry.ts}-${index}`} style={styles.logRow}>
              <Text style={styles.logTime}>{time(entry.ts)}</Text>
              <Text style={[styles.logText, !entry.ok && styles.logFail]}>
                {entry.node} {entry.ok ? "ok" : "failed"} {entry.ms ? `${entry.ms} ms` : ""}{" "}
                {entry.decidedBy ? `(${entry.decidedBy})` : ""} {entry.error || ""}
              </Text>
            </View>
          ))
        )}
        <View style={styles.row}>
          <Button
            title="Clear log"
            variant="ghost"
            small
            style={styles.flexButton}
            onPress={() => dispatch(clearRouterLog())}
          />
        </View>
      </Card>

      <Card>
        <Field
          label="Mesh port used for scanning and job dispatch"
          value={String(router.port)}
          onChangeText={(value) => dispatch(setRouterPort(parseInt(value, 10) || 8080))}
          keyboardType="number-pad"
        />
      </Card>

      {router.error ? (
        <Banner
          tone="danger"
          title="Router error"
          text={String(router.error)}
          actionLabel="Hide"
          onAction={() => dispatch(clearRouterError())}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing(4), paddingBottom: spacing(10) },
  title: { fontSize: font(15), fontWeight: "700", color: colors.text },
  mono: { fontSize: font(12.5), color: colors.muted, fontWeight: "500" },
  body: { ...typography.small, marginTop: spacing(2), lineHeight: 18 },
  hint: { ...typography.small, marginTop: spacing(2.5), lineHeight: 17 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2), marginTop: spacing(2.5) },
  cardButton: { marginTop: spacing(3) },
  row: { flexDirection: "row", gap: spacing(2), marginTop: spacing(3) },
  flexButton: { flex: 1 },
  progressText: { ...typography.small, marginTop: spacing(1.5) },
  policyCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing(3.5),
    marginTop: spacing(2),
  },
  policyCardActive: { borderColor: colors.primary, borderWidth: 1 },
  policyTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing(2) },
  jobInput: { minHeight: 80, textAlignVertical: "top" },
  answerBox: {
    marginTop: spacing(3),
    padding: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  answerMeta: { ...typography.small, fontWeight: "700" },
  answerText: { color: colors.text, marginTop: spacing(1.5), lineHeight: 20 },
  planGoalText: { ...typography.small, marginTop: spacing(2.5), fontStyle: "italic" },
  stepInstruction: { ...typography.small, marginTop: spacing(1), lineHeight: 16 },
  finalBox: {
    marginTop: spacing(3),
    padding: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  linkButton: { marginTop: spacing(2.5) },
  logRow: { flexDirection: "row", gap: spacing(2), marginTop: spacing(1.5) },
  logTime: { ...typography.small, width: 74 },
  logText: { ...typography.small, flex: 1, lineHeight: 17 },
  logFail: { color: colors.danger },
  error: { ...typography.small, color: colors.danger, marginTop: spacing(2) },
});
