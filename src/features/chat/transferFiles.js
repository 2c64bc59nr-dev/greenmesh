import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { FORMATS, renderExport } from "./transfer";

/**
 * File side of chat transfer: render chats to disk and hand the file to the
 * Android share sheet, or read a picked file back as text.
 *
 * No Redux here on purpose - the slice owns the state, this module owns the
 * filesystem, and transfer.js owns the format rules.
 */

const EXPORT_DIR = `${FileSystem.documentDirectory}exports/`;

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

async function ensureExportDir() {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
}

/** Write the file (always) and open the share sheet (when it exists). */
export async function writeExportFile(conversations, format = FORMATS.JSONL, { share = true, suffix = "" } = {}) {
  const { text, extension, mimeType } = renderExport(conversations, format);
  await ensureExportDir();
  const name = `greenmesh-chats${suffix}-${stamp()}.${extension}`;
  const uri = `${EXPORT_DIR}${name}`;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });

  let shared = false;
  if (share) {
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: "Export chats" });
        shared = true;
      }
    } catch (error) {
      // The file is written either way - the UI reports the path.
    }
  }
  return { uri, name, bytes: text.length, format, shared };
}

/** Let the user pick a file and give back its text. */
export async function pickTextFile() {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ["application/json", "application/x-ndjson", "text/plain", "application/octet-stream", "*/*"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) return { canceled: true };
  const asset = picked.assets[0];
  const text = await FileSystem.readAsStringAsync(asset.uri);
  return { canceled: false, text, name: asset.name || "picked file" };
}
export { EXPORT_DIR };

export default { renderExport, writeExportFile, pickTextFile, EXPORT_DIR };
