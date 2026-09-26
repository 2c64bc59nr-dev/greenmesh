/**
 * Chat import / export.
 *
 * The format for this job is JSON Lines: one conversation per line, with
 * OpenAI-shaped messages:
 *
 *   {"title":"Solar panels","created_at":"2026-09-26T18:00:00.000Z","messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
 *
 * That is what ChatGPT and Claude exports, most chat-dataset tooling and every
 * fine-tuning pipeline speak, and being line-delimited it streams and appends
 * without rewriting the file. Markdown is offered as a human-readable second
 * export, and import also accepts a plain JSON array of conversations, a bare
 * OpenAI `messages` array, ChatGPT's `conversations.json`, and our own JSON
 * bundle - because "import my chats" should not fail on the shape.
 *
 * Everything here is pure: strings in, plain objects out, so the rules are
 * testable without a phone.
 */

export const FORMATS = { JSONL: "jsonl", MARKDOWN: "md", JSON: "json" };

const ROLE_SET = new Set(["system", "user", "assistant", "tool"]);

const iso = (ts) => (ts ? new Date(ts).toISOString() : new Date().toISOString());

const roleOf = (role) => {
  const value = String(role || "user").toLowerCase();
  return ROLE_SET.has(value) ? value : "user";
};

/**
 * Text out of a message whose content may be a string or OpenAI content parts.
 * Data URLs are dropped on purpose: a single base64 photo would dwarf the whole
 * export and no chat tool can round-trip it anyway.
 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function imageRefOf(message) {
  const url = message.imageUrl || (message.image && message.image.uri) || null;
  if (!url) return null;
  // Keep a link to the photo, but never inline a base64 blob.
  return String(url).startsWith("data:") ? "data-url-omitted" : String(url);
}

/** One stored conversation -> one transferable conversation. */
export function conversationToExportable(conversation) {
  const messages = (conversation.messages || [])
    .map((message) => {
      const entry = { role: roleOf(message.role), content: textOf(message.content) };
      const image = imageRefOf(message);
      if (image) entry.image_url = image;
      if (message.ts) entry.ts = iso(message.ts);
      return entry;
    })
    .filter((message) => message.content.trim().length > 0 || message.image_url);

  return {
    title: conversation.title || "Untitled chat",
    created_at: iso(conversation.createdAt),
    messages,
  };
}

export function conversationsToExportable(conversations) {
  return (conversations || [])
    .map(conversationToExportable)
    // A chat with nothing in it is not worth a line in someone's export.
    .filter((conversation) => conversation.messages.length > 0);
}

/** JSON Lines: the primary export. */
export function toJsonl(conversations) {
  return `${conversationsToExportable(conversations)
    .map((conversation) => JSON.stringify(conversation))
    .join("\n")}\n`;
}

/** Human-readable export: one `## title` section per chat. */
export function toMarkdown(conversations) {
  const blocks = conversationsToExportable(conversations).map((conversation) => {
    const lines = conversation.messages.map((message) => {
      const image = message.image_url ? `\n\n![image](${message.image_url})` : "";
      return `**${message.role}:** ${message.content}${image}`;
    });
    return `## ${conversation.title}\n\n_${conversation.created_at}_\n\n${lines.join("\n\n")}`;
  });
  return `${blocks.join("\n\n---\n\n")}\n`;
}

/** Our own JSON bundle - the thing `parseAny` is happiest reading back. */
export function toJsonBundle(conversations) {
  return `${JSON.stringify(
    { format: "greenmesh-chats", version: 1, exported_at: new Date().toISOString(), conversations: conversationsToExportable(conversations) },
    null,
    2
  )}\n`;
}

/** One call for callers that want text + the file metadata that goes with it. */
export function renderExport(conversations, format = FORMATS.JSONL) {
  if (format === FORMATS.MARKDOWN) {
    return { text: toMarkdown(conversations), extension: "md", mimeType: "text/markdown" };
  }
  if (format === FORMATS.JSON) {
    return { text: toJsonBundle(conversations), extension: "json", mimeType: "application/json" };
  }
  return { text: toJsonl(conversations), extension: "jsonl", mimeType: "application/x-ndjson" };
}

function normalizeMessages(rawMessages) {
  return (rawMessages || [])
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const content = typeof message.content === "string" ? message.content : textOf(message.content);
      const imageUrl = message.image_url || (message.image && (message.image.uri || message.image.url)) || null;
      const entry = { role: roleOf(message.role || (message.author && message.author.role)), content };
      if (imageUrl) entry.image = { uri: String(imageUrl) };
      const ts = message.ts || message.created_at || message.create_time;
      if (ts) entry.ts = typeof ts === "number" ? ts : Date.parse(ts) || undefined;
      return entry;
    })
    .filter(Boolean);
}

function normalizeConversation(raw, index) {
  if (!raw || typeof raw !== "object") return null;

  // ChatGPT's export nests messages in a `mapping` graph; walk it in order.
  if (raw.mapping && typeof raw.mapping === "object") {
    const nodes = Object.values(raw.mapping);
    const messages = nodes
      .map((node) => node && node.message)
      .filter(Boolean)
      .map((message) => ({
        role: message.author && message.author.role,
        content: textOf(message.content && message.content.parts),
        create_time: message.create_time,
      }));
    return normalizeConversation(
      { title: raw.title || `Imported chat ${index + 1}`, messages, create_time: raw.create_time },
      index
    );
  }

  const rawMessages = raw.messages || raw.chat_messages || raw.items;
  if (!Array.isArray(rawMessages)) return null;
  const messages = normalizeMessages(rawMessages);
  if (messages.length === 0) return null;
  const created = raw.created_at || raw.create_time || raw.createdAt;
  return {
    title: raw.title || raw.name || `Imported chat ${index + 1}`,
    createdAt: created ? (typeof created === "number" ? created * (created < 1e12 ? 1000 : 1) : Date.parse(created) || Date.now()) : Date.now(),
    messages,
  };
}

/**
 * Read any of the shapes above. Returns { conversations, format } - or an empty
 * list with a reason, never a throw, so the UI can say what went wrong.
 */
export function parseAny(text) {
  const source = String(text || "").trim();
  if (!source) return { conversations: [], format: null, error: "The file is empty." };

  // 1. A whole JSON document first: that is unambiguous. A single-chat JSONL
  //    export is also one line, so order matters - whichever one parses whole wins.
  let document = null;
  let documentIsJson = true;
  try {
    document = JSON.parse(source);
  } catch (error) {
    documentIsJson = false;
  }

  if (documentIsJson) {
    // 1a. ChatGPT's conversations.json is a bare array of mapping-based chats.
    const candidates = Array.isArray(document)
      ? document
      : Array.isArray(document.conversations)
      ? document.conversations
      : Array.isArray(document.chats)
      ? document.chats
      : null;
    if (candidates) {
      // An array of messages is a single chat, not a list of chats.
      if (candidates.length && candidates[0] && candidates[0].role && !candidates[0].messages) {
        const one = normalizeConversation({ title: "Imported chat", messages: candidates }, 0);
        return one
          ? { conversations: [one], format: FORMATS.JSON, error: null }
          : { conversations: [], format: null, error: "No messages found in that file." };
      }
      const conversations = candidates.map((item, index) => normalizeConversation(item, index)).filter(Boolean);
      if (conversations.length) return { conversations, format: FORMATS.JSON, error: null };
      return { conversations: [], format: null, error: "No messages found in that file." };
    }

    // 1b. A single conversation object.
    const one = normalizeConversation(document, 0);
    if (one) return { conversations: [one], format: FORMATS.JSON, error: null };
    // It parsed as JSON but holds nothing we can use - fall through and see
    // whether the caller handed us JSON Lines instead.
    if (!Array.isArray(document) && !document.messages && !document.mapping) {
      return { conversations: [], format: null, error: "Unrecognised chat file." };
    }
  }

  // 2. JSON Lines: every non-blank line is its own conversation.
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length) {
    const parsedLines = [];
    let allLinesAreJson = true;
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch (error) {
        allLinesAreJson = false;
        break;
      }
    }
    if (allLinesAreJson && parsedLines.length) {
      const conversations = parsedLines.map((item, index) => normalizeConversation(item, index)).filter(Boolean);
      if (conversations.length) return { conversations, format: FORMATS.JSONL, error: null };
    }
  }

  return { conversations: [], format: null, error: "Not valid JSON or JSON Lines." };
}

/** Stable-enough fingerprint for duplicate detection across imports. */
function fingerprint(conversation) {
  const first = conversation.messages[0];
  return [
    String(conversation.title || "").trim().toLowerCase(),
    conversation.messages.length,
    first ? `${first.role}:${String(first.content).trim().slice(0, 120)}` : "",
  ].join("|");
}

const defaultId = () => `imported-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Merge imported chats into the existing ones. Ids and timestamps are minted
 * here so an import never collides with what is already stored, and a chat that
 * is already present (same title and same opening message) is skipped rather
 * than duplicated.
 */
export function mergeConversations(existing, incoming, makeId = defaultId) {
  const known = new Set((existing || []).map(fingerprint));
  const added = [];
  for (const conversation of incoming || []) {
    const key = fingerprint(conversation);
    if (known.has(key)) continue;
    known.add(key);
    added.push({
      id: makeId(),
      title: conversation.title,
      createdAt: conversation.createdAt,
      messages: conversation.messages,
    });
  }
  return added;
}

export default {
  FORMATS,
  conversationToExportable,
  conversationsToExportable,
  mergeConversations,
  parseAny,
  renderExport,
  toJsonBundle,
  toJsonl,
  toMarkdown,
};
