import "dotenv/config";
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

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/tools", toolRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/integrations", integrationRoutes);
app.get("/api/health", (req, res) => res.json({ ok: true }));

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Recur server listening on http://localhost:${PORT}`);
    if (!process.env.API_KEY) {
      console.warn("⚠ No API_KEY set in server/.env. Chat still works for anyone who saves their own key on the Integrations page.");
    }
  });
});
