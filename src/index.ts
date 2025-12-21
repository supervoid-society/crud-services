import { Hono } from "hono";
import { cors } from "hono/cors";
import catalogRoutes from "./routes/catalog";
import imageRoutes from "./routes/images";
import transactionRoutes from "./routes/transaction";
import reviewRoutes from "./routes/reviews";

interface JWTPayload {
  userId: string;
  username: string;
  role: string;
  exp: number;
}

type Bindings = {
  JWT_SECRET: string;
  D1: D1Database;
};

const app = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JWTPayload } }>();

app.use('*', cors({ origin: '*' }));

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.route("/catalog-items", catalogRoutes);
app.route("/images", imageRoutes);
app.route("/transactions", transactionRoutes);
app.route("/reviews", reviewRoutes);

export default app;
