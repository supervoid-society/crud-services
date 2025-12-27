import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

interface JWTPayload {
  userId: string;
  username: string;
  role: string;
  exp: number;
}

interface Review {
  id: string;
  transaction_id: string;
  rating: number;
  comment: string | null;
  reply: string | null;
  created_at: string;
  updated_at: string;
  buyer_id: string;
  buyer_username?: string;
}

const reviews = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JWTPayload } }>();

// GET /reviews/:item_id - Get reviews for a specific item
reviews.get("/:item_id", async (c) => {
  const itemId = c.req.param("item_id");

  // Get reviews with transaction details to include buyer info
  const reviewsQuery = `
    SELECT r.*, t.buyer_id
    FROM reviews r
    JOIN transactions t ON r.transaction_id = t.id
    WHERE t.item_id = ? AND t.status = 'completed'
    ORDER BY r.created_at DESC
  `;
  const reviewsResult = await c.env.D1.prepare(reviewsQuery).bind(itemId).all();

  if (!reviewsResult.success) {
    return c.json({ error: "Failed to fetch reviews" }, 500);
  }

  const reviewsData: Review[] = reviewsResult.results.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    transaction_id: row.transaction_id as string,
    rating: Number(row.rating),
    comment: row.comment as string | null,
    reply: row.reply as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    buyer_id: row.buyer_id as string,
  }));

  return c.json(reviewsData);
});

// POST /reviews - Add a new review
reviews.post("/", authMiddleware, async (c) => {
  const body = await c.req.json();
  const { transaction_id, rating, comment } = body;
  const payload = c.get("jwtPayload");
  const userId = payload?.userId;
  const role = payload?.role;

  if (role !== 'buyer') {
    return c.json({ error: "Only buyers can add reviews" }, 403);
  }

  if (!transaction_id || !rating || rating < 1 || rating > 5) {
    return c.json({ error: "Transaction ID and rating (1-5) are required" }, 400);
  }

  // Check if transaction exists and belongs to user and is completed
  const transactionQuery = `
    SELECT t.*, ci.user_id as seller_id
    FROM transactions t
    JOIN catalog_items ci ON t.item_id = ci.id
    WHERE t.id = ? AND t.buyer_id = ? AND t.status = 'completed'
  `;
  const transactionResult = await c.env.D1.prepare(transactionQuery).bind(transaction_id, userId).first();

  if (!transactionResult) {
    return c.json({ error: "Invalid transaction or not completed" }, 403);
  }

  // Check if review already exists for this transaction
  const existingReview = await c.env.D1.prepare("SELECT id FROM reviews WHERE transaction_id = ?").bind(transaction_id).first();
  if (existingReview) {
    return c.json({ error: "Review already exists for this transaction" }, 400);
  }

  // Insert review
  const reviewId = crypto.randomUUID();
  const insertResult = await c.env.D1.prepare(`
    INSERT INTO reviews (id, transaction_id, rating, comment)
    VALUES (?, ?, ?, ?)
  `).bind(reviewId, transaction_id, rating, comment || null).run();

  if (!insertResult.success) {
    return c.json({ error: "Failed to add review" }, 500);
  }

  return c.json({ message: "Review added successfully" });
});

// PUT /reviews/:id - Update review (buyer can edit their own review)
reviews.put("/:id", authMiddleware, async (c) => {
  const reviewId = c.req.param("id");
  const body = await c.req.json();
  const { rating, comment } = body;
  const payload = c.get("jwtPayload");
  const userId = payload?.userId;
  const role = payload?.role;

  if (role !== 'buyer') {
    return c.json({ error: "Only buyers can update reviews" }, 403);
  }

  // Check if review belongs to user
  const reviewQuery = `
    SELECT r.*, t.buyer_id
    FROM reviews r
    JOIN transactions t ON r.transaction_id = t.id
    WHERE r.id = ?
  `;
  const reviewResult = await c.env.D1.prepare(reviewQuery).bind(reviewId).first();

  if (!reviewResult) {
    return c.json({ error: "Review not found" }, 404);
  }

  if (reviewResult.buyer_id !== userId) {
    return c.json({ error: "You can only update your own reviews" }, 403);
  }

  if (rating && (rating < 1 || rating > 5)) {
    return c.json({ error: "Rating must be between 1 and 5" }, 400);
  }

  // Update review
  const updateFields = [];
  const values = [];
  if (rating !== undefined) {
    updateFields.push("rating = ?");
    values.push(rating);
  }
  if (comment !== undefined) {
    updateFields.push("comment = ?");
    values.push(comment || null);
  }
  updateFields.push("updated_at = current_timestamp");
  values.push(reviewId);

  const updateResult = await c.env.D1.prepare(`
    UPDATE reviews SET ${updateFields.join(", ")} WHERE id = ?
  `).bind(...values).run();

  if (!updateResult.success) {
    return c.json({ error: "Failed to update review" }, 500);
  }

  return c.json({ message: "Review updated successfully" });
});

// PUT /reviews/:id/reply - Seller reply to review (can add or edit reply)
reviews.put("/:id/reply", authMiddleware, async (c) => {
  const reviewId = c.req.param("id");
  const body = await c.req.json();
  const { reply } = body;
  const payload = c.get("jwtPayload");
  const userId = payload?.userId;
  const role = payload?.role;

  if (role !== 'seller') {
    return c.json({ error: "Only sellers can reply to reviews" }, 403);
  }

  // Get review and check if seller owns the item
  const reviewQuery = `
    SELECT r.*, t.item_id, ci.user_id as seller_id
    FROM reviews r
    JOIN transactions t ON r.transaction_id = t.id
    JOIN catalog_items ci ON t.item_id = ci.id
    WHERE r.id = ?
  `;
  const reviewResult = await c.env.D1.prepare(reviewQuery).bind(reviewId).first();

  if (!reviewResult) {
    return c.json({ error: "Review not found" }, 404);
  }

  if (reviewResult.seller_id !== userId) {
    return c.json({ error: "You can only reply to reviews of your items" }, 403);
  }

  // Update reply (can be null to remove reply, or new reply text)
  const updateResult = await c.env.D1.prepare(`
    UPDATE reviews SET reply = ?, updated_at = current_timestamp WHERE id = ?
  `).bind(reply || null, reviewId).run();

  if (!updateResult.success) {
    return c.json({ error: "Failed to update reply" }, 500);
  }

  return c.json({ message: "Reply updated successfully" });
});

export default reviews;