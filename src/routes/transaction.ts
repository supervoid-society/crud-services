import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { sign, verify } from "@tsndr/cloudflare-worker-jwt";

interface JWTPayload {
  userId: string;
  username: string;
  role: string;
  exp: number;
}

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

const transaction = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JWTPayload } }>();

// Get all transactions (for admin)
transaction.get("/", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  if (payload.role !== 'admin') {
    return c.json({ error: "Admin only" }, 403);
  }

  const transactions = await c.env.D1.prepare("SELECT * FROM transactions ORDER BY created_at DESC").all();
  return c.json(transactions.results);
});

// Get transactions for user (buyer or seller)
transaction.get("/user", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  const userId = payload.userId;
  const role = payload.role;

  let query = "";
  if (role === 'buyer') {
    query = `
      SELECT t.*, c.name as item_name, c.image_id as item_image_id 
      FROM transactions t
      JOIN catalog_items c ON t.item_id = c.id
      WHERE t.buyer_id = ? 
      ORDER BY t.created_at DESC
    `;
  } else if (role === 'seller') {
    query = `
      SELECT t.*, c.name as item_name, c.image_id as item_image_id 
      FROM transactions t
      JOIN catalog_items c ON t.item_id = c.id
      WHERE t.seller_id = ? 
      ORDER BY t.created_at DESC
    `;
  } else {
    return c.json({ error: "Invalid role" }, 403);
  }

  const transactions = await c.env.D1.prepare(query).bind(userId).all();
  return c.json(transactions.results);
});

// Create transaction
transaction.post("/", authMiddleware, async (c) => {
  const { buyerId, sellerId, itemId, quantity, amount } = await c.req.json();
  const payload = c.get("jwtPayload");

  if (payload.role !== 'buyer') {
    return c.json({ error: "Only buyers can create transactions" }, 403);
  }

  if (payload.userId !== buyerId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  // Insert transaction
  const transactionId = crypto.randomUUID();
  await c.env.D1.prepare(
    "INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
  ).bind(transactionId, buyerId, sellerId, itemId, quantity, amount).run();

  return c.json({ id: transactionId, message: "Transaction created" });
});

// Update transaction status
transaction.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json();
  const payload = c.get("jwtPayload");

  if (payload.role !== 'admin') {
    return c.json({ error: "Admin only" }, 403);
  }

  await c.env.D1.prepare("UPDATE transactions SET status = ?, updated_at = current_timestamp WHERE id = ?").bind(status, id).run();
  return c.json({ message: "Transaction updated" });
});

// Checkout endpoint
transaction.post("/checkout", authMiddleware, async (c) => {
  const { itemId, quantity, balance, signature } = await c.req.json();
  console.log("Checkout request:", { itemId, quantity, balance });

  const payload = c.get("jwtPayload");

  if (payload.role !== 'buyer') {
    return c.json({ error: "Only buyers can checkout" }, 403);
  }

  const buyerId = payload.userId;

  // Verify balance signature
  try {
    const decoded = await verify(signature, c.env.JWT_SECRET);
    if (!decoded) {
      return c.json({ error: "Invalid signature" }, 400);
    }
    const sigPayload = decoded.payload as any;
    if (!sigPayload ||
        sigPayload.balance !== balance ||
        sigPayload.userId !== buyerId ||
        (Date.now() - sigPayload.timestamp) > 300000) { // 5 minutes expiry
      return c.json({ error: "Invalid signature or expired" }, 400);
    }
  } catch (error) {
    return c.json({ error: "Signature verification failed" }, 400);
  }

  // Get cart item to get catalog item_id
  const cartItem = await c.env.D1.prepare("SELECT item_id, quantity as cartQuantity FROM cart WHERE id = ? AND user_id = ?").bind(itemId, buyerId).first() as { item_id: string; cartQuantity: number } | undefined;
  if (!cartItem) {
    return c.json({ error: "Cart item not found" }, 404);
  }

  const catalogItemId = cartItem.item_id;
  const actualQuantity = cartItem.cartQuantity; // Use quantity from cart, ignore frontend

  // Get item details including current stock
  const item = await c.env.D1.prepare("SELECT price, qty, user_id as sellerId FROM catalog_items WHERE id = ?").bind(catalogItemId).first() as { price: number; qty: number; sellerId: string } | undefined;
  console.log("Item found:", item);

  if (!item) {
    return c.json({ error: "Catalog item not found" }, 404);
  }

  // Check stock availability
  if (item.qty < actualQuantity) {
    return c.json({ error: `Insufficient stock. Available: ${item.qty}, requested: ${actualQuantity}` }, 400);
  }

  const amount = item.price * actualQuantity;

  if (balance < amount) {
    return c.json({ error: "Insufficient balance" }, 400);
  }

  // Create transaction
  const transactionId = crypto.randomUUID();
  await c.env.D1.prepare(
    "INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, 'completed')"
  ).bind(transactionId, buyerId, item.sellerId, catalogItemId, actualQuantity, amount).run();

  // Reduce stock
  const newQty = item.qty - actualQuantity;
  await c.env.D1.prepare("UPDATE catalog_items SET qty = ?, updated_at = current_timestamp WHERE id = ?")
    .bind(newQty, catalogItemId).run();

  // Remove item from cart
  await c.env.D1.prepare("DELETE FROM cart WHERE id = ? AND user_id = ?").bind(itemId, buyerId).run();

  // Create signature for transfer
  const transferData = { transactionId, sellerId: item.sellerId, amount, buyerId };
  const transferSignature = await sign(transferData, c.env.JWT_SECRET);

  return c.json({ transactionId, sellerId: item.sellerId, amount, signature: transferSignature });
});

// Test route
transaction.get("/test", (c) => c.text("Transaction routes working"));

export default transaction;