import { Hono } from "hono";
import { cors } from "hono/cors";
import catalogRoutes from "./routes/catalog";
import imageRoutes from "./routes/images";

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

const app = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: any } }>();

app.use('*', cors({ origin: '*' }));

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.route("/catalog-items", catalogRoutes);
app.route("/images", imageRoutes);

export default app;
