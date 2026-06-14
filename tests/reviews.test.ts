import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { sign } from "@tsndr/cloudflare-worker-jwt";
import app from "../src/index";

describe("CRUD Services - Reviews", () => {
  let buyerToken: string;
  let sellerToken: string;
  let transactionId: string;
  let itemId: string;

  beforeAll(async () => {
    buyerToken = await sign({ userId: "buyer-1", username: "buyer", role: "buyer" }, env.JWT_SECRET);
    sellerToken = await sign({ userId: "seller-1", username: "seller", role: "seller" }, env.JWT_SECRET);

    // Initialize schema
    const schema = `
DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS cart;
DROP TABLE IF EXISTS reviews;

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
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);

CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    reply TEXT,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);
`;
    const queries = schema.split(";").filter((q) => q.trim());
    for (const query of queries) {
      await env.D1.prepare(query).run();
    }

    // Setup initial data
    itemId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO catalog_items (id, name, price, qty, user_id) VALUES (?, ?, ?, ?, ?)").bind(itemId, "Test Item", 100, 10, "seller-1").run();

    transactionId = crypto.randomUUID();
    await env.D1.prepare("INSERT INTO transactions (id, buyer_id, seller_id, item_id, quantity, amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(transactionId, "buyer-1", "seller-1", itemId, 1, 100, "completed")
      .run();
  });

  it("should add a review", async () => {
    const res = await app.request(
      "/reviews",
      {
        method: "POST",
        body: JSON.stringify({
          transaction_id: transactionId,
          rating: 5,
          comment: "Great product!",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${buyerToken}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.message).toBe("Review added successfully");
  });

  it("should list reviews for an item", async () => {
    const res = await app.request(`/reviews/${itemId}`, {}, env);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].comment).toBe("Great product!");
  });

  it("should allow seller to reply", async () => {
    const reviewsRes = await app.request(`/reviews/${itemId}`, {}, env);
    const reviews = (await reviewsRes.json()) as any[];
    const reviewId = reviews[0].id;

    const res = await app.request(
      `/reviews/${reviewId}/reply`,
      {
        method: "PUT",
        body: JSON.stringify({
          reply: "Thank you for your feedback!",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sellerToken}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.message).toBe("Reply updated successfully");
  });
});
