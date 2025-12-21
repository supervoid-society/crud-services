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
  const data = (image as any).data as Uint8Array;
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  return c.json({ data: base64, content_type: (image as any).content_type });
});

export default images;