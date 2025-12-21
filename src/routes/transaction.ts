import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";

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
    query = "SELECT * FROM transactions WHERE buyer_id = ? ORDER BY created_at DESC";
  } else if (role === 'seller') {
    query = "SELECT * FROM transactions WHERE seller_id = ? ORDER BY created_at DESC";
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

export default transaction;