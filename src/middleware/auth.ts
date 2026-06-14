import { verify } from "@tsndr/cloudflare-worker-jwt";
import { Context, Next } from "hono";

export const authMiddleware = async (c: Context, next: Next) => {
  console.log("Auth middleware called for path:", c.req.path);
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    console.log("No auth header");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    console.log("JWT Payload:", decoded);
    if (!decoded || !decoded.payload) {
      console.log("Invalid token payload");
      return c.json({ error: "Invalid token payload" }, 401);
    }
    c.set("jwtPayload", decoded.payload);
    console.log("Auth successful, calling next");
    await next();
  } catch (error) {
    console.log("JWT Verify Error:", error);
    return c.json({ error: "Invalid token" }, 401);
  }
};
