import { verify } from "@tsndr/cloudflare-worker-jwt";

export const authMiddleware = async (c: any, next: any) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = auth.slice(7);
  try {
    const decoded = await verify(token, c.env.JWT_SECRET);
    console.log("JWT Payload:", decoded);
    if (!decoded || !decoded.payload) {
      return c.json({ error: "Invalid token payload" }, 401);
    }
    c.set("jwtPayload", decoded.payload);
    await next();
  } catch (error) {
    console.log("JWT Verify Error:", error);
    return c.json({ error: "Invalid token" }, 401);
  }
};