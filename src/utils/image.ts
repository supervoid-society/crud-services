import { Context } from "hono";

export async function saveImage(c: Context, base64Data: string, contentType: string): Promise<string | null> {
  try {
    const base64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const binaryData = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const imageId = crypto.randomUUID();
    await c.env.D1.prepare("INSERT INTO images (id, data, content_type) VALUES (?, ?, ?)").bind(imageId, binaryData, contentType).run();
    return imageId;
  } catch (error) {
    console.error("Error saving image:", error);
    return null;
  }
}