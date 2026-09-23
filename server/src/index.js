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
const PORT = process.env.PORT || 8787;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// When the client has been built into client/dist, serve it from this same
// process. This lets the whole app run as ONE free hosting service (Render,
// Railway, Fly.io) with no separate frontend host and no CORS/cookie issues.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
const servingClient = fs.existsSync(clientDist);

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/tools", toolRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/integrations", integrationRoutes);
app.get("/api/health", (req, res) => res.json({ ok: true }));

if (servingClient) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-API route returns the app so page refreshes work.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Recur server listening on http://localhost:${PORT}`);
    console.log(servingClient ? "Serving the built client from client/dist." : "API only — no built client found at client/dist.");
    console.log("Default model backend: Ollama Local");
  });
});
