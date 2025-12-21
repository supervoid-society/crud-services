import { Hono } from "hono";
import { verify } from "@tsndr/cloudflare-worker-jwt";
import { authMiddleware } from "../middleware/auth";
import { saveImage } from "../utils/image";

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

interface JWTPayload {
  userId: number;
  username: string;
  role: string;
  exp: number;
}

const catalog = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: any } }>();

catalog.post("/", authMiddleware, async (c) => {
  const body = await c.req.json();
  const { name, description, price: priceStr, image_base64, image_content_type } = body;
  const payload = c.get("jwtPayload");
  console.log("Payload in handler:", payload);
  const userId = payload?.userId;
  const role = payload?.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can create catalog items" }, 403);
  }

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
  await c.env.D1.prepare("INSERT INTO catalog_items (id, name, description, price, image_id, user_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(itemId, name, description || null, price, imageId, userId).run();

  return c.json({ id: itemId, name, description: description || null, price, image_id: imageId });
});

catalog.get("/", async (c) => {
  const auth = c.req.header("Authorization");
  let items;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    try {
      const decoded = await verify(token, c.env.JWT_SECRET);
      if (!decoded || !decoded.payload) {
        items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
      } else {
        const payload = decoded.payload as JWTPayload;
        const role = payload.role;
        const userId = payload.userId;
        if (role === 'admin') {
          items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
        } else if (role === 'seller') {
          items = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE user_id = ?").bind(userId).all();
        } else {
          // buyer or other roles
          items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
        }
      }
    } catch {
      items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
    }
  } else {
    // public access
    items = await c.env.D1.prepare("SELECT * FROM catalog_items").all();
  }
  return c.json(items.results);
});

catalog.get("/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(id).first();
  if (!item) {
    return c.json({ error: "Item not found" }, 404);
  }
  return c.json(item);
});

catalog.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { name, description, price, image_base64, image_content_type } = await c.req.json();
  const payload = c.get("jwtPayload");
  const userId = payload.userId;
  const role = payload.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can update catalog items" }, 403);
  }

  const existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND user_id = ?").bind(id, userId).first();
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

catalog.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const payload = c.get("jwtPayload");
  const userId = payload.userId;
  const role = payload.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can delete catalog items" }, 403);
  }

  const existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!existingItem) {
    return c.json({ error: "Item not found or unauthorized" }, 404);
  }

  if (existingItem.image_id) {
    await c.env.D1.prepare("DELETE FROM images WHERE id = ?").bind(existingItem.image_id).run();
  }

  await c.env.D1.prepare("DELETE FROM catalog_items WHERE id = ?").bind(id).run();

  return c.json({ message: "Item deleted" });
});

export default catalog;