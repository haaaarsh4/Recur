import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { init } from "./db.js";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chats.js";
import toolRoutes from "./routes/tools.js";
import statsRoutes from "./routes/stats.js";
import integrationRoutes from "./routes/integrations.js";

const app = express();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vercel builds every /api request into one serverless function. Depending on
// the build settings the function is then handed the address it was reached at
// rather than the original path, so map the function's own address back onto
// the /api prefix the routers are mounted under. Locally nothing matches and
// this middleware is a no-op.
const FUNCTION_ADDRESS = /^\/api\/index(?:\.js)?(?=\/|$)/;
app.use((req, _res, next) => {
  if (FUNCTION_ADDRESS.test(req.url)) req.url = `/api${req.url.replace(FUNCTION_ADDRESS, "")}`;
  next();
});

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// A standalone server can prepare the database before it starts listening. A
// serverless function cannot, because the module is imported and invoked in one
// step, so hold the startup promise and let every request wait on it. Without
// this the first request after a cold start would read an empty database.
const ready = init().catch((err) => {
  console.error("Database init failed:", err?.message || err);
});
app.use(async (_req, _res, next) => {
  await ready;
  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/tools", toolRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/integrations", integrationRoutes);
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// When the client has been built into client/dist, serve it from this same
// process. This lets the whole app run as ONE hosting service (Vercel, Render,
// Railway, Fly.io) with no separate frontend host and no CORS/cookie issues.
// Hosts that publish client/dist as static output answer first, so this is the
// fallback for the paths a static host cannot resolve.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
const servingClient = fs.existsSync(clientDist);

if (servingClient) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-API route returns the app so page refreshes work.
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

export { app, ready, servingClient };
export default app;
