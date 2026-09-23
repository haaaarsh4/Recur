import { Router } from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { beginOAuth, finishOAuth } from "../oauth.js";

const router = Router();

router.get("/google", (req, res) => beginOAuth(req, res, "google"));
router.get("/google/callback", (req, res) => finishOAuth(req, res, "google"));
router.get("/github", (req, res) => beginOAuth(req, res, "github"));
router.get("/github/callback", (req, res) => finishOAuth(req, res, "github"));

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};
const PASSWORD_MIN_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/register", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Your password must be at least ${PASSWORD_MIN_LENGTH} characters long.` });
  }
  await db.read();
  if (db.data.users.find((u) => String(u.email).toLowerCase() === email)) {
    return res.status(409).json({ error: "An account with that email already exists. Try logging in instead." });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = { id: nanoid(), email, passwordHash, name: name || email.split("@")[0], createdAt: Date.now() };
  db.data.users.push(user);
  adoptGuestChats(req, user.id);
  await db.write();
  res.cookie("token", signToken(user), COOKIE_OPTS);
  res.clearCookie("guest_id");
  res.json({ id: user.id, email: user.email, name: user.name });
});

router.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!EMAIL_PATTERN.test(email) || !password) {
    return res.status(400).json({ error: "Enter your email address and password." });
  }
  await db.read();
  const user = db.data.users.find((u) => String(u.email).toLowerCase() === email);
  if (!user || !user.passwordHash) return res.status(401).json({ error: "That email or password is incorrect." });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "That email or password is incorrect." });
  adoptGuestChats(req, user.id);
  await db.write();
  res.cookie("token", signToken(user), COOKIE_OPTS);
  res.clearCookie("guest_id");
  res.json({ id: user.id, email: user.email, name: user.name });
});

// Carry the visitor's guest chats into their account so the conversation they
// just had is not lost the moment they decide to sign up. The chats lose their
// guest flag and become permanent account history.
function adoptGuestChats(req, userId) {
  const guestId = req.cookies?.guest_id;
  if (!guestId) return;
  const ownerId = "guest:" + guestId;
  for (const chat of db.data.chats) {
    if (chat.userId === ownerId) {
      chat.userId = userId;
      chat.guest = false;
      chat.adoptedAt = Date.now();
    }
  }
}

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
});

export default router;
