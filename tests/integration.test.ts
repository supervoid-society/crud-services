import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { sign } from "@tsndr/cloudflare-worker-jwt";
import app from "../src/index";

describe("CRUD Services - Full Integration Flow", () => {
  let buyerToken: string;
  let sellerToken: string;
  let itemId: string;
  let transactionId: string;
  let reviewId: string;

  beforeAll(async () => {
    buyerToken = await sign({ userId: "int-buyer-1", username: "buyer", role: "buyer" }, env.JWT_SECRET);
    sellerToken = await sign({ userId: "int-seller-1", username: "seller", role: "seller" }, env.JWT_SECRET);

    const schema = `
DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS cart;
DROP TABLE IF EXISTS reviews;

CREATE TABLE catalog_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price REAL NOT NULL, qty INTEGER NOT NULL DEFAULT 0, image_id TEXT, user_id TEXT NOT NULL, is_archived INTEGER DEFAULT 0, created_at TEXT DEFAULT current_timestamp, updated_at TEXT DEFAULT current_timestamp);
CREATE TABLE images (id TEXT PRIMARY KEY, data BLOB NOT NULL, content_type TEXT NOT NULL DEFAULT 'image/jpeg', created_at TEXT DEFAULT current_timestamp, updated_at TEXT DEFAULT current_timestamp);
CREATE TABLE transactions (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, item_id TEXT NOT NULL, quantity INTEGER NOT NULL, amount DECIMAL(10,2) NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')), created_at TEXT DEFAULT current_timestamp, updated_at TEXT DEFAULT current_timestamp, FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE);
CREATE TABLE cart (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT current_timestamp, updated_at TEXT DEFAULT current_timestamp, FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE, UNIQUE(user_id, item_id));
CREATE TABLE reviews (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5), comment TEXT, reply TEXT, created_at TEXT DEFAULT current_timestamp, updated_at TEXT DEFAULT current_timestamp, FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE);
`;
    const queries = schema.split(";").filter(q => q.trim());
    for (const query of queries) {
      await env.D1.prepare(query).run();
    }
  });

  it("1. Seller creates a catalog item", async () => {
    const res = await app.request("/catalog-items", {
      method: "POST",
      body: JSON.stringify({
        name: "Integration Item",
        description: "An item for integration testing",
        price: 50,
        qty: 100
      }),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sellerToken}` }
    }, env);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.id).toBeDefined();
    itemId = data.id;
  });

  it("2. Buyer views catalog and sees the item", async () => {
    const res = await app.request("/catalog-items", {}, env);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].id).toBe(itemId);
  });

  it("3. Buyer adds item to cart", async () => {
    const res = await app.request("/catalog-items/cart", {
      method: "POST",
      body: JSON.stringify({ itemId, quantity: 2 }),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${buyerToken}` }
    }, env);
    expect(res.status).toBe(200);
  });

  it("4. Buyer views cart", async () => {
    const res = await app.request("/catalog-items/cart", {
      headers: { "Authorization": `Bearer ${buyerToken}` }
    }, env);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].item_id).toBe(itemId);
    expect(data[0].quantity).toBe(2);
  });

  it("5. Buyer checks out cart", async () => {
    const res = await app.request("/catalog-items/checkout", {
      method: "POST",
      headers: { "Authorization": `Bearer ${buyerToken}` }
    }, env);
    expect(res.status).toBe(200);

    // Verify cart is empty
    const cartRes = await app.request("/catalog-items/cart", {
      headers: { "Authorization": `Bearer ${buyerToken}` }
    }, env);
    const cartData: any = await cartRes.json();
    expect(cartData.length).toBe(0);

    // Get the created transaction
    const transactions = await env.D1.prepare("SELECT * FROM transactions WHERE buyer_id = ?").bind("int-buyer-1").all();
    expect(transactions.results.length).toBe(1);
    transactionId = transactions.results[0].id as string;
    expect(transactions.results[0].quantity).toBe(2);
    expect(transactions.results[0].amount).toBe(100);
  });

  it("6. Buyer leaves a review for the transaction", async () => {
    const res = await app.request("/reviews", {
      method: "POST",
      body: JSON.stringify({
        transaction_id: transactionId,
        rating: 5,
        comment: "Excellent integration item!"
      }),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${buyerToken}` }
    }, env);
    expect(res.status).toBe(200);

    // Verify review is visible
    const reviewsRes = await app.request(`/reviews/${itemId}`, {}, env);
    const reviewsData: any = await reviewsRes.json();
    expect(reviewsData.length).toBe(1);
    expect(reviewsData[0].comment).toBe("Excellent integration item!");
    reviewId = reviewsData[0].id;
  });

  it("7. Seller replies to the review", async () => {
    const res = await app.request(`/reviews/${reviewId}/reply`, {
      method: "PUT",
      body: JSON.stringify({
        reply: "Thanks for testing!"
      }),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sellerToken}` }
    }, env);
    expect(res.status).toBe(200);

    const reviewsRes = await app.request(`/reviews/${itemId}`, {}, env);
    const reviewsData: any = await reviewsRes.json();
    expect(reviewsData[0].reply).toBe("Thanks for testing!");
  });
});
