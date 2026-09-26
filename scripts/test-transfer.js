/**
 * Tests for the chat transfer layer. Plain node: run with
 *   node scripts/test-transfer.js
 * The module is ESM-imported through babel so it matches what the app loads.
 */
const babel = require("@babel/core");
const path = require("path");

const file = path.join(__dirname, "..", "src", "features", "chat", "transfer.js");
const { code } = babel.transformFileSync(file, {
  presets: ["babel-preset-expo"],
  plugins: ["@babel/plugin-transform-modules-commonjs"],
});
const module_ = { exports: {} };
new Function("module", "exports", "require", code)(module_, module_.exports, require);
const t = module_.exports;

let failures = 0;
const check = (name, condition, extra) => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ""}`);
  }
};

const chats = [
  {
    id: "a",
    title: "Solar panels",
    createdAt: Date.UTC(2026, 8, 26, 10, 0, 0),
    messages: [
      { role: "user", content: "How do panels work?", ts: Date.UTC(2026, 8, 26, 10, 0, 1) },
      { role: "assistant", content: "Photons knock electrons loose.", ts: Date.UTC(2026, 8, 26, 10, 0, 2) },
      { role: "user", content: "", image: { uri: "file:///data/pic.jpg" } },
      { role: "user", content: "and this?", imageUrl: "data:image/png;base64,AAAA" },
    ],
  },
  { id: "b", title: "Empty buffer", createdAt: Date.now(), messages: [{ role: "user", content: "   " }] },
  {
    id: "c",
    title: "Second chat",
    createdAt: Date.UTC(2026, 8, 25, 8, 0, 0),
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "Capital of Poland?" },
      { role: "assistant", content: "Warsaw." },
    ],
  },
];

console.log("export");
const jsonl = t.toJsonl(chats);
const jsonlLines = jsonl.trim().split("\n");
check("jsonl has one line per non-empty chat", jsonlLines.length === 2, `${jsonlLines.length} lines`);
const first = JSON.parse(jsonlLines[0]);
check("title survives", first.title === "Solar panels");
check("created_at is ISO", /^\d{4}-\d{2}-\d{2}T/.test(first.created_at));
check("roles are OpenAI shaped", first.messages.every((m) => ["system", "user", "assistant", "tool"].includes(m.role)));
check("blank-only and image-less messages dropped", first.messages.length === 4, `${first.messages.length}`);
check("file:// image kept as a link", first.messages[2].image_url === "file:///data/pic.jpg");
check("base64 image never inlined", first.messages[3].image_url === "data-url-omitted");
check(
  "chats with no real messages are skipped",
  !jsonl.includes("Empty buffer"),
  jsonl.slice(0, 60)
);

const markdown = t.toMarkdown(chats);
check("markdown titles as headings", markdown.includes("## Solar panels"));
check("markdown labels roles", markdown.includes("**assistant:**"));

const bundle = t.toJsonBundle(chats);
check("bundle is valid JSON", typeof JSON.parse(bundle) === "object");

console.log("import: jsonl round trip");
const back = t.parseAny(jsonl);
check("no error", back.error === null, back.error);
check("both conversations", back.conversations.length === 2, `${back.conversations.length}`);
check("format detected as jsonl", back.format === "jsonl", String(back.format));
check("messages preserved", back.conversations[0].messages.length === 4);
check("system role preserved", back.conversations[1].messages[0].role === "system");
check("timestamp restored", typeof back.conversations[0].messages[0].ts === "number");

// A one-chat export is a single line, which is also valid JSON: it must import
// either way, and the label is allowed to say json.
const singleLine = t.parseAny(t.toJsonl([chats[0]]));
check("single-line export still imports", singleLine.conversations.length === 1, singleLine.error);

console.log("import: other shapes");
const bareMessages = JSON.stringify([
  { role: "user", content: "one" },
  { role: "assistant", content: "two" },
]);
check("bare OpenAI messages array", t.parseAny(bareMessages).conversations.length === 1);

const arrayOfChats = JSON.stringify([
  { title: "x", messages: [{ role: "user", content: "hi" }] },
  { title: "y", messages: [{ role: "user", content: "yo" }] },
]);
check("array of chats", t.parseAny(arrayOfChats).conversations.length === 2);

const bundleBack = t.parseAny(bundle);
check("our own bundle", bundleBack.conversations.length === 2, `${bundleBack.conversations.length} ${bundleBack.error || ""}`);

const chatgpt = JSON.stringify({
  title: "ChatGPT chat",
  mapping: {
    n1: { message: { author: { role: "user" }, content: { parts: ["hello"] }, create_time: 1700000000 } },
    n2: { message: { author: { role: "assistant" }, content: { parts: ["hi there"] }, create_time: 1700000001 } },
  },
});
const gpt = t.parseAny(chatgpt);
check("chatgpt mapping shape", gpt.conversations.length === 1 && gpt.conversations[0].messages.length === 2, gpt.error);

check("empty file reports a reason", t.parseAny("").error !== null);
check("garbage reports a reason", t.parseAny("not json at all").error !== null);
check("json with no messages reports a reason", t.parseAny('{"foo":1}').error !== null);

console.log("merge");
const existing = [{ id: "a", title: "Solar panels", createdAt: 1, messages: chats[0].messages.slice(0, 2) }];
const added = t.mergeConversations(existing, t.parseAny(jsonl).conversations, () => "new-id");
check("fresh ids", added.every((c) => c.id === "new-id"));
check("a chat with a different length is not a duplicate", added.length === 2, `${added.length}`);
check("re-importing the same file twice adds nothing", t.mergeConversations(added, added, () => "x").length === 0);
const dupe = t.mergeConversations(
  [{ title: "Solar panels", messages: [{ role: "user", content: "How do panels work?" }] }],
  [{ title: "Solar panels", createdAt: Date.now(), messages: [{ role: "user", content: "How do panels work?" }] }]
);
check("identical chat is skipped", dupe.length === 0, JSON.stringify(dupe).slice(0, 80));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
