/**
 * Convert stored conversation messages into the shapes the two backends expect.
 *
 * Stored message:  { role, content, image?: { uri, mimeType } }
 * Outgoing variant: { role, content, imageUrl } - a file:// uri for llama.cpp
 *                   or a data: URL for HTTP APIs.
 *
 * Both OpenAI-compatible APIs and llama.rn accept the multimodal content-part
 * array, so the same builder serves both paths.
 */

export const DEFAULT_IMAGE_PROMPT = "What is in this photo?";

const urlFor = (message) => message.imageUrl || (message.image && message.image.uri) || null;

export function hasImage(message) {
  return Boolean(urlFor(message));
}

/** OpenAI / llama.rn chat messages (content parts when a photo is attached). */
export function toChatMessages(messages, imagePrompt) {
  return messages.map((message) => {
    const url = urlFor(message);
    if (!url) return { role: message.role, content: message.content || "" };
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content && message.content.trim() ? message.content : imagePrompt || DEFAULT_IMAGE_PROMPT },
        { type: "image_url", image_url: { url } },
      ],
    };
  });
}

/** System prompt + messages, in the multimodal shape. */
export function withSystemPrompt(messages, systemPrompt, imagePrompt) {
  const formatted = toChatMessages(messages, imagePrompt);
  const hasSystem = formatted.some((message) => message.role === "system");
  if (hasSystem || !systemPrompt) return formatted;
  return [{ role: "system", content: systemPrompt }, ...formatted];
}

export function containsMedia(messages) {
  return messages.some((message) => hasImage(message));
}

export default { toChatMessages, withSystemPrompt, containsMedia, hasImage, DEFAULT_IMAGE_PROMPT };
