import { Hono } from "hono";

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

const images = new Hono<{ Bindings: Bindings }>();

images.get("/:id", async (c) => {
  const id = c.req.param("id");
  const image = await c.env.D1.prepare("SELECT data, content_type FROM images WHERE id = ?").bind(id).first();
  if (!image) {
    return c.json({ error: "Image not found" }, 404);
  }
  const { data, content_type } = image as { data: Uint8Array; content_type: string };
  let binaryData: Uint8Array;
  if (typeof data === 'string') {
    // Assume base64
    try {
      binaryData = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    } catch (e) {
      console.error("Invalid base64 data:", e);
      return new Response("Invalid image data", { status: 500 });
    }
  } else if (data instanceof Uint8Array) {
    binaryData = data;
  } else {
    console.error("Unsupported data type:", typeof data);
    return new Response("Unsupported image data type", { status: 500 });
  }
  return new Response(binaryData, { headers: { 'Content-Type': content_type } });
});

export default images;