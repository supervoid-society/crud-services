import { Hono } from "hono";
import { cors } from "hono/cors";
import { verify } from "@tsndr/cloudflare-worker-jwt";

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

const app = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: any } }>();

app.use('*', cors({ origin: '*' }));

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

const authMiddleware = async (c: any, next: any) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    console.log("JWT Payload:", decoded);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    c.set("jwtPayload", decoded.payload);
    await next();
  } catch (error) {
    console.log("JWT Verify Error:", error);
    return c.json({ error: "Invalid token" }, 401);
  }
};

async function saveImage(c: any, base64Data: string, contentType: string): Promise<string | null> {
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

app.post("/catalog-items", authMiddleware, async (c) => {
  const body = await c.req.json();
  const { name, description, price: priceStr, image_base64, image_content_type } = body;
  const payload = c.get("jwtPayload");
  console.log("Payload in handler:", payload);
  const userId = payload?.userId;

  const price = Number(priceStr);
  if (!name || isNaN(price)) {
    return c.json({ error: "Name and valid price are required" }, 400);
  }

  if (!userId) {
    return c.json({ error: "Invalid user" }, 401);
  }

  let imageId = null;
  if (image_base64) {
    imageId = await saveImage(c, image_base64, image_content_type || "image/jpeg");
    if (!imageId) {
      return c.json({ error: "Failed to save image" }, 500);
    }
  }

  const itemId = crypto.randomUUID();
  await c.env.D1.prepare("INSERT INTO catalog_items (id, name, description, price, image_id, created_by_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(itemId, name, description || null, price, imageId, userId).run();

  return c.json({ id: itemId, name, description: description || null, price, image_id: imageId });
});

app.get("/catalog-items", async (c) => {
  const items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
  return c.json(items.results);
});

app.get("/catalog-items/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(id).first();
  if (!item) {
    return c.json({ error: "Item not found" }, 404);
  }
  return c.json(item);
});

// Delete catalog item
app.put("/catalog-items/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { name, description, price, image_base64, image_content_type } = await c.req.json();
  const userId = c.get("jwtPayload").userId;

  const existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND created_by_id = ?").bind(id, userId).first();
  if (!existingItem) {
    return c.json({ error: "Item not found or unauthorized" }, 404);
  }

  let imageId = existingItem.image_id;
  if (image_base64) {
    if (imageId) {
      await c.env.D1.prepare("DELETE FROM images WHERE id = ?").bind(imageId).run();
    }
    imageId = await saveImage(c, image_base64, image_content_type || "image/jpeg");
    if (!imageId) {
      return c.json({ error: "Failed to save image" }, 500);
    }
  }

  await c.env.D1.prepare("UPDATE catalog_items SET name = ?, description = ?, price = ?, image_id = ?, updated_at = current_timestamp WHERE id = ?")
    .bind(name, description, price, imageId, id).run();

  return c.json({ id, name, description, price, image_id: imageId });
});

app.delete("/catalog-items/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("jwtPayload").userId;

  const existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND created_by_id = ?").bind(id, userId).first();
  if (!existingItem) {
    return c.json({ error: "Item not found or unauthorized" }, 404);
  }

  if (existingItem.image_id) {
    await c.env.D1.prepare("DELETE FROM images WHERE id = ?").bind(existingItem.image_id).run();
  }

  await c.env.D1.prepare("DELETE FROM catalog_items WHERE id = ?").bind(id).run();

  return c.json({ message: "Item deleted" });
});

app.get("/images/:id", async (c) => {
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

export default app;
