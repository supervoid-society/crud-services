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

CREATE TABLE catalog_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    image_id TEXT,
    user_id TEXT NOT NULL,
    is_archived INTEGER DEFAULT 0,
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
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE
);
`;
    const queries = schema.split(";").filter(q => q.trim());
    for (const query of queries) {
      await env.D1.prepare(query).run();
    }

    // Setup initial data
    itemId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO catalog_items (id, name, price, qty, user_id) VALUES (?, ?, ?, ?, ?)")
      .bind(itemId, "Transaction Test Item", 100, 10, "seller-1").run();
  });

  it("should list transactions for a buyer", async () => {
    // Create a dummy transaction
    const txId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(txId, "buyer-1", "seller-1", itemId, 1, 100, "completed").run();

    const res = await app.request("/transactions/user", {
      headers: { Authorization: `Bearer ${buyerToken}` }
    }, env);

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe(txId);
  });

  it("should list transactions for a seller", async () => {
    const res = await app.request("/transactions/user", {
      headers: { Authorization: `Bearer ${sellerToken}` }
    }, env);

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});