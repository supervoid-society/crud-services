import { Hono } from "hono";
import { verify } from "@tsndr/cloudflare-worker-jwt";
import { authMiddleware } from "../middleware/auth";
import { saveImage } from "../utils/image";

type Bindings = {
  JWT_SECRET: string;
  AUTH_URL: string;
  D1: D1Database;
};

interface JWTPayload {
  userId: string;
  username: string;
  role: string;
  exp: number;
}

interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  qty: number;
  image_id: string | null;
  user_id: string;
  created_at?: string;
  updated_at?: string;
}

interface CartItem {
  user_id: string;
  item_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

interface CartItemWithDetails extends CartItem {
  name: string;
  price: number;
  image_id: string | null;
  seller_id: string;
}

interface CartItemWithStock extends CartItem {
  name: string;
  price: number;
  available_qty: number;
  seller_id: string;
}

interface BalanceResponse {
  balance: number;
}

const catalog = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JWTPayload } }>();

catalog.post("/", authMiddleware, async (c) => {
  const body = await c.req.json();
  const { name, description, price: priceStr, qty: qtyStr, image_base64, image_content_type } = body;
  const payload = c.get("jwtPayload");
  console.log("Payload in handler:", payload);
  const userId = payload?.userId;
  const role = payload?.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can create catalog items" }, 403);
  }

  const price = Number(priceStr);
  const qty = qtyStr ? Number(qtyStr) : 0;
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
  await c.env.D1.prepare("INSERT INTO catalog_items (id, name, description, price, qty, image_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(itemId, name, description || null, price, qty, imageId, userId).run();

  return c.json({ id: itemId, name, description: description || null, price, qty, image_id: imageId });
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

// Cart routes
catalog.get("/cart", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    const payload = decoded.payload as JWTPayload;
    const userId = payload.userId;

    const cartItems = await c.env.D1.prepare(`
      SELECT c.*, ci.name, ci.price, ci.image_id, ci.user_id as seller_id
      FROM cart c
      JOIN catalog_items ci ON c.item_id = ci.id
      WHERE c.user_id = ?
      ORDER BY c.created_at DESC
    `).bind(userId).all();

    console.log(`Cart items for user ${userId}:`, cartItems.results);
    return c.json((cartItems.results as unknown as CartItemWithDetails[]) || []);
  } catch (error) {
    console.log("Error fetching cart:", error);
    return c.json({ error: "Failed to fetch cart" }, 500);
  }
});

catalog.post("/cart", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    const payload = decoded.payload as JWTPayload;
    const userId = payload.userId;
    const { itemId, quantity } = await c.req.json();

    if (!itemId || !quantity || quantity < 1) {
      return c.json({ error: "Invalid itemId or quantity" }, 400);
    }

    // Check if item exists and has stock
    const item = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(itemId).first() as CatalogItem | undefined;
    if (!item) {
      return c.json({ error: "Item not found" }, 404);
    }

    if (item.qty < quantity) {
      return c.json({ error: "Insufficient stock" }, 400);
    }

  // Check if item already in cart
  const existingCartItem = await c.env.D1.prepare("SELECT * FROM cart WHERE user_id = ? AND item_id = ?").bind(userId, itemId).first() as CartItem | undefined;

  if (existingCartItem) {
    // Update quantity
    const newQuantity = existingCartItem.quantity + quantity;
    if (newQuantity > item.qty) {
      return c.json({ error: "Total quantity exceeds available stock" }, 400);
    }

    await c.env.D1.prepare("UPDATE cart SET quantity = ?, updated_at = current_timestamp WHERE user_id = ? AND item_id = ?")
      .bind(newQuantity, userId, itemId).run();
  } else {
    // Add new item to cart
    const cartId = crypto.randomUUID();
    await c.env.D1.prepare("INSERT INTO cart (id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)")
      .bind(cartId, userId, itemId, quantity).run();
  }

  return c.json({ message: "Item added to cart" });
  } catch (error) {
    console.error("Error adding to cart:", error);
    return c.json({ error: "Failed to add item to cart" }, 500);
  }
});

catalog.put("/cart/:itemId", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    const payload = decoded.payload as JWTPayload;
    const userId = payload.userId;
    const itemId = c.req.param("itemId");
    const { quantity } = await c.req.json();

    if (!quantity || quantity < 1) {
      return c.json({ error: "Invalid quantity" }, 400);
    }

    // Check if item exists and has stock
    const item = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(itemId).first() as CatalogItem | undefined;
    if (!item) {
      return c.json({ error: "Item not found" }, 404);
    }

    if (item.qty < quantity) {
      return c.json({ error: "Insufficient stock" }, 400);
    }

    // Update cart item
    const result = await c.env.D1.prepare("UPDATE cart SET quantity = ?, updated_at = current_timestamp WHERE user_id = ? AND item_id = ?")
      .bind(quantity, userId, itemId).run();

    if (result.meta.changes === 0) {
      return c.json({ error: "Item not in cart" }, 404);
    }

  return c.json({ message: "Cart updated" });
  } catch (error) {
    console.error("Error updating cart:", error);
    return c.json({ error: "Failed to update cart" }, 500);
  }
});

catalog.delete("/cart/:itemId", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    const payload = decoded.payload as JWTPayload;
    const userId = payload.userId;
    const itemId = c.req.param("itemId");

    const result = await c.env.D1.prepare("DELETE FROM cart WHERE user_id = ? AND item_id = ?")
      .bind(userId, itemId).run();

    if (result.meta.changes === 0) {
      return c.json({ error: "Item not in cart" }, 404);
    }

    return c.json({ message: "Item removed from cart" });
  } catch (error) {
    console.error("Error removing from cart:", error);
    return c.json({ error: "Failed to remove item from cart" }, 500);
  }
});

catalog.delete("/cart", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    const payload = decoded.payload as JWTPayload;
    const userId = payload.userId;

    await c.env.D1.prepare("DELETE FROM cart WHERE user_id = ?").bind(userId).run();

    return c.json({ message: "Cart cleared" });
  } catch (error) {
    console.error("Error clearing cart:", error);
    return c.json({ error: "Failed to clear cart" }, 500);
  }
});

catalog.get("/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(id).first() as CatalogItem | undefined;
  if (!item) {
    return c.json({ error: "Item not found" }, 404);
  }
  return c.json(item);
});

catalog.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { name, description, price, qty, image_base64, image_content_type } = await c.req.json();
  const payload = c.get("jwtPayload");
  const userId = payload.userId;
  const role = payload.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can update catalog items" }, 403);
  }

  const existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND user_id = ?").bind(id, userId).first() as CatalogItem | undefined;
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

  await c.env.D1.prepare("UPDATE catalog_items SET name = ?, description = ?, price = ?, qty = ?, image_id = ?, updated_at = current_timestamp WHERE id = ?")
    .bind(name, description, price, qty, imageId, id).run();

  return c.json({ id, name, description, price, qty, image_id: imageId });
});

catalog.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const payload = c.get("jwtPayload");
  const userId = payload.userId;
  const role = payload.role;

  if (role !== 'seller' && role !== 'admin') {
    return c.json({ error: "Only sellers and admins can delete catalog items" }, 403);
  }

  // For sellers, check if they own the item
  let existingItem;
  if (role === 'seller') {
    existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ? AND user_id = ?").bind(id, userId).first() as CatalogItem | undefined;
    if (!existingItem) {
      return c.json({ error: "Item not found or unauthorized" }, 404);
    }
  } else {
    // For admins, just check if item exists
    existingItem = await c.env.D1.prepare("SELECT * FROM catalog_items WHERE id = ?").bind(id).first() as CatalogItem | undefined;
    if (!existingItem) {
      return c.json({ error: "Item not found" }, 404);
    }
  }

  if (existingItem.image_id) {
    await c.env.D1.prepare("DELETE FROM images WHERE id = ?").bind(existingItem.image_id).run();
  }

  await c.env.D1.prepare("DELETE FROM catalog_items WHERE id = ?").bind(id).run();

  return c.json({ message: "Item deleted" });
});

catalog.post("/checkout", async (c) => {
  // Get auth token from header
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Authorization required" }, 401);
  }
  const token = authHeader.slice(7);

  // Decode token to get user info
  const { verify } = await import("@tsndr/cloudflare-worker-jwt");
  let payload: JWTPayload;
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token" }, 401);
    }
    payload = decoded.payload as JWTPayload;
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }

  if (payload.role !== 'buyer') {
    return c.json({ error: "Only buyers can checkout" }, 403);
  }

  const buyerId = payload.userId;
  const AUTH_URL = c.env.AUTH_URL;

  // Get cart items from database
  const cartItems = await c.env.D1.prepare(`
    SELECT c.*, ci.name, ci.price, ci.qty as available_qty, ci.user_id as seller_id
    FROM cart c
    JOIN catalog_items ci ON c.item_id = ci.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).bind(buyerId).all();

  if (cartItems.results.length === 0) {
    return c.json({ error: "Cart is empty" }, 400);
  }

  // Check stock and calculate total
  let totalAmount = 0;
  const stockChecks: { item: CartItemWithStock; existingItem: CartItemWithStock }[] = [];
  
  for (const cartItem of cartItems.results as unknown as CartItemWithStock[]) {
    const currentQty = cartItem.available_qty || 0;
    if (currentQty < cartItem.quantity) {
      return c.json({ error: `Insufficient stock for ${cartItem.name}. Available: ${currentQty}, requested: ${cartItem.quantity}` }, 400);
    }
    
    totalAmount += cartItem.price * cartItem.quantity;
    stockChecks.push({ item: cartItem, existingItem: cartItem });
  }

  // Check balance
  try {
    const balanceRes = await fetch(`${AUTH_URL}/auth/balance/${buyerId}/buyer`);
    if (!balanceRes.ok) {
      return c.json({ error: "Failed to check balance" }, 500);
    }
    const balanceData = await balanceRes.json() as BalanceResponse;
    if (balanceData.balance < totalAmount) {
      return c.json({ error: `Insufficient balance. Available: ${balanceData.balance}, needed: ${totalAmount}` }, 400);
    }
  } catch {
    return c.json({ error: "Balance check failed" }, 500);
  }

  // Process transfers and transactions
  for (const { item, existingItem } of stockChecks) {
    const sellerId = existingItem.seller_id;
    const amount = existingItem.price * item.quantity;

    // Transfer money
    try {
      const transferRes = await fetch(`${AUTH_URL}/auth/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyerId, sellerId, amount }),
      });
      if (!transferRes.ok) {
        return c.json({ error: "Transfer failed" }, 500);
      }
    } catch {
      return c.json({ error: "Transfer request failed" }, 500);
    }

    // Create transaction
    try {
      const transactionId = crypto.randomUUID();
      await c.env.D1.prepare(
        "INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, 'completed')"
      ).bind(transactionId, buyerId, sellerId, item.item_id, item.quantity, amount).run();
    } catch {
      return c.json({ error: "Transaction creation failed" }, 500);
    }

    // Reduce stock
    const newQty = existingItem.available_qty - item.quantity;
    await c.env.D1.prepare("UPDATE catalog_items SET qty = ?, updated_at = current_timestamp WHERE id = ?")
      .bind(newQty, item.item_id).run();
  }

  // Clear cart after successful checkout
  await c.env.D1.prepare("DELETE FROM cart WHERE user_id = ?").bind(buyerId).run();

  return c.json({ message: "Checkout successful" });
});

export default catalog;