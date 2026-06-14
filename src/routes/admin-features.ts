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

const adminFeatures = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JWTPayload } }>();

// GET platform settings (Public to logged in users for calculations)
adminFeatures.get("/platform-settings", authMiddleware, async (c) => {
  try {
    const settings = await c.env.D1.prepare("SELECT * FROM platform_settings").all();
    const result = (settings.results as any[]).reduce((acc, cur) => {
      acc[cur.key] = cur.value;
      return acc;
    }, {} as Record<string, string>);

    return c.json({
      fee_type: result.fee_type || "percentage",
      fee_percentage: parseFloat(result.fee_percentage || "0.00"),
      fee_fixed: parseFloat(result.fee_fixed || "0.00"),
    });
  } catch (error) {
    return c.json({ error: "Failed to fetch settings" }, 500);
  }
});

// PUT platform settings (Admin only)
adminFeatures.put("/platform-settings", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  if (payload.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const { fee_type, fee_percentage, fee_fixed } = await c.req.json();
  if (!fee_type || (fee_type !== "percentage" && fee_type !== "fixed" && fee_type !== "both")) {
    return c.json({ error: "Invalid fee type" }, 400);
  }

  try {
    await c.env.D1.batch([
      c.env.D1.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('fee_type', ?)").bind(fee_type),
      c.env.D1.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('fee_percentage', ?)").bind(String(fee_percentage || 0)),
      c.env.D1.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('fee_fixed', ?)").bind(String(fee_fixed || 0)),
    ]);
    return c.json({ message: "Platform settings updated successfully" });
  } catch (error) {
    return c.json({ error: "Failed to update platform settings" }, 500);
  }
});

// GET all promo codes (Admin only)
adminFeatures.get("/promos", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  if (payload.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  try {
    const result = await c.env.D1.prepare("SELECT * FROM promos ORDER BY created_at DESC").all();
    return c.json(result.results);
  } catch (error) {
    return c.json({ error: "Failed to fetch promos" }, 500);
  }
});

// POST create promo code (Admin only)
adminFeatures.post("/promos", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  if (payload.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const { code, type, value, max_uses } = await c.req.json();
  if (!code || !type || value === undefined || parseFloat(value) <= 0) {
    return c.json({ error: "Invalid parameters. Code, type, and positive value are required." }, 400);
  }

  if (type !== "percentage" && type !== "fixed") {
    return c.json({ error: "Invalid type. Must be percentage or fixed." }, 400);
  }

  const id = crypto.randomUUID();
  try {
    await c.env.D1.prepare("INSERT INTO promos (id, code, type, value, max_uses, used_count) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(id, code.toUpperCase().trim(), type, parseFloat(value), max_uses ? parseInt(max_uses) : null)
      .run();
    return c.json({ message: "Promo code created", id });
  } catch (error) {
    return c.json({ error: "Failed to create promo code. Code may already exist." }, 400);
  }
});

// DELETE promo code (Admin only)
adminFeatures.delete("/promos/:id", authMiddleware, async (c) => {
  const payload = c.get("jwtPayload");
  if (payload.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const id = c.req.param("id");
  try {
    await c.env.D1.prepare("DELETE FROM promos WHERE id = ?").bind(id).run();
    return c.json({ message: "Promo code deleted" });
  } catch (error) {
    return c.json({ error: "Failed to delete promo code" }, 500);
  }
});

// POST validate promo code (Anyone logged in)
adminFeatures.post("/promos/validate", authMiddleware, async (c) => {
  const { code } = await c.req.json();
  if (!code) {
    return c.json({ error: "Promo code is required" }, 400);
  }

  try {
    const promo = (await c.env.D1.prepare("SELECT * FROM promos WHERE code = ?").bind(code.toUpperCase().trim()).first()) as any;
    if (!promo) {
      return c.json({ error: "Promo code not found" }, 404);
    }
    if (promo.is_active === 0) {
      return c.json({ error: "Promo code is inactive" }, 400);
    }
    if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
      return c.json({ error: "Promo code usage limit reached" }, 400);
    }

    return c.json({
      valid: true,
      code: promo.code,
      type: promo.type,
      value: promo.value,
    });
  } catch (error) {
    return c.json({ error: "Failed to validate promo code" }, 500);
  }
});

export default adminFeatures;
