import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { sign } from "@tsndr/cloudflare-worker-jwt";
import app from "../src/index";

describe("CRUD Services - Catalog", () => {
  let token: string;

  beforeAll(async () => {
    token = await sign({ userId: "seller-1", username: "seller", role: "seller" }, env.JWT_SECRET);
    // ... rest of schema
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
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);

CREATE TABLE images (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
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
    const queries = schema.split(";").filter(q => q.trim());
    for (const query of queries) {
      await env.D1.prepare(query).run();
    }
  });

  it("should return Hello Hono!", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hello Hono!");
  });

  it("should create a catalog item", async () => {
    const res = await app.request("/catalog-items", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Item",
        description: "Test Description",
        price: 100,
        qty: 10,
        user_id: "seller-1"
      }),
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      }
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
  });

  it("should list catalog items", async () => {
    const res = await app.request("/catalog-items", {}, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("should get a single catalog item", async () => {
    const itemsRes = await app.request("/catalog-items", {}, env);
    const items = await itemsRes.json() as any[];
    const itemId = items[0].id;

    const res = await app.request(`/catalog-items/${itemId}`, {}, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(itemId);
  });

  it("should update a catalog item", async () => {
    const itemsRes = await app.request("/catalog-items", {}, env);
    const items = await itemsRes.json() as any[];
    const itemId = items[0].id;

    const res = await app.request(`/catalog-items/${itemId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Updated Item",
        price: 150,
        qty: 5
      }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      }
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Updated Item");
  });

  it("should add to cart", async () => {
    const itemsRes = await app.request("/catalog-items", {}, env);
    const items = await itemsRes.json() as any[];
    const itemId = items[0].id;

    const buyerToken = await sign({ userId: "buyer-1", username: "buyer", role: "buyer" }, env.JWT_SECRET);

    const res = await app.request("/catalog-items/cart", {
      method: "POST",
      body: JSON.stringify({
        itemId,
        quantity: 2
      }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${buyerToken}`
      }
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Item added to cart");
  });

  it("should list cart items", async () => {
    const buyerToken = await sign({ userId: "buyer-1", username: "buyer", role: "buyer" }, env.JWT_SECRET);

    const res = await app.request("/catalog-items/cart", {
      headers: {
        "Authorization": `Bearer ${buyerToken}`
      }
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("should delete a catalog item", async () => {
    const itemsRes = await app.request("/catalog-items", {}, env);
    const items = await itemsRes.json() as any[];
    const itemId = items[0].id;

    const res = await app.request(`/catalog-items/${itemId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toBe("Item deleted");
  });
});
