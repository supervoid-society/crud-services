import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { sign } from "@tsndr/cloudflare-worker-jwt";
import app from "../src/index";

describe("CRUD Services - Transactions", () => {
  let buyerToken: string;
  let sellerToken: string;
  let itemId: string;

  beforeAll(async () => {
    buyerToken = await sign({ userId: "buyer-1", username: "buyer", role: "buyer" }, env.JWT_SECRET);
    sellerToken = await sign({ userId: "seller-1", username: "seller", role: "seller" }, env.JWT_SECRET);

    // Initialize schema
    const schema = `
DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS cart;

CREATE TABLE catalog_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    image_id TEXT,
    user_id TEXT NOT NULL,
    is_archived INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    platform_fee REAL DEFAULT 0.0,
    promo_code TEXT,
    discount_amount REAL DEFAULT 0.0,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE
);

CREATE TABLE cart (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE,
    UNIQUE(user_id, item_id)
);
`;
    const queries = schema.split(";").filter((q) => q.trim());
    for (const query of queries) {
      await env.D1.prepare(query).run();
    }

    // Setup initial data
    itemId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO catalog_items (id, name, price, qty, user_id) VALUES (?, ?, ?, ?, ?)").bind(itemId, "Transaction Test Item", 100, 10, "seller-1").run();
  });

  it("should list transactions for a buyer", async () => {
    // Create a dummy transaction
    const txId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(txId, "buyer-1", "seller-1", itemId, 1, 100, "completed")
      .run();

    const res = await app.request(
      "/transactions/user",
      {
        headers: { Authorization: `Bearer ${buyerToken}` },
      },
      env
    );

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe(txId);
  });

  it("should list transactions for a seller", async () => {
    const res = await app.request(
      "/transactions/user",
      {
        headers: { Authorization: `Bearer ${sellerToken}` },
      },
      env
    );

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("should cancel a transaction and restore stock/cart", async () => {
    const txId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, 'completed')")
      .bind(txId, "buyer-1", "seller-1", itemId, 3, 300)
      .run();

    // Call cancel endpoint
    const res = await app.request(
      "/transactions/cancel",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: txId }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.message).toContain("cancelled");

    // Verify transaction is failed
    const tx = await env.D1.prepare("SELECT status FROM transactions WHERE id = ?").bind(txId).first();
    expect(tx?.status).toBe("failed");

    // Verify stock is restored (10 + 3 = 13)
    const item = await env.D1.prepare("SELECT qty FROM catalog_items WHERE id = ?").bind(itemId).first();
    expect(item?.qty).toBe(13);

    // Verify item is back in cart
    const cartItem = await env.D1.prepare("SELECT quantity FROM cart WHERE user_id = ? AND item_id = ?").bind("buyer-1", itemId).first();
    expect(cartItem?.quantity).toBe(3);
  });
});
