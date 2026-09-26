import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";

export const IMAGES_DIR = `${FileSystem.documentDirectory}images/`;

const ensureDir = async () => {
  const info = await FileSystem.getInfoAsync(IMAGES_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(IMAGES_DIR, { intermediates: true });
  }
};

const extensionFor = (asset) => {
  const fromName = asset.fileName && asset.fileName.split(".").pop();
  const candidate = (fromName || "").toLowerCase();
  if (candidate === "png" || candidate === "webp" || candidate === "jpg" || candidate === "jpeg") {
    return candidate === "jpeg" ? "jpg" : candidate;
  }
  const mime = (asset.mimeType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
};

const mimeFor = (uri) => {
  const clean = String(uri).split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
};

/**
 * Pick a photo from the device gallery and copy it into the app's private
 * storage, so the uri in a saved conversation keeps working after a restart.
 * Returns null when the user cancels.
 */
export async function pickImage() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Photo access denied. Enable it for GreenMesh AI in Android settings.");
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.7,
    allowsMultipleSelection: false,
    exif: false,
  });
  if (result.canceled || !result.assets || !result.assets.length) return null;

  const asset = result.assets[0];
  await ensureDir();
  const target = `${IMAGES_DIR}img-${Date.now()}.${extensionFor(asset)}`;
  await FileSystem.copyAsync({ from: asset.uri, to: target });
  return {
    uri: target,
    width: asset.width || 0,
    height: asset.height || 0,
    mimeType: asset.mimeType || mimeFor(target),
  };
}

/** Read an image as a data URL. Used for HTTP API calls and the local server. */
export async function toDataUrl(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return `data:${mimeFor(uri)};base64,${base64}`;
}

/** Delete a stored photo (best effort). */
export async function deleteImage(uri) {
  if (!uri || !String(uri).startsWith(IMAGES_DIR)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    // the file may already be gone
  }
}

export default { pickImage, toDataUrl, deleteImage, IMAGES_DIR };
