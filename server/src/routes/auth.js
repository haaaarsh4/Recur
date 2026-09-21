import { Router } from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post("/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email and a password of at least 6 characters are required." });
  }
  await db.read();
  if (db.data.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nanoid(), email, passwordHash, name: name || email.split("@")[0], createdAt: Date.now() };
  db.data.users.push(user);
  adoptGuestChats(req, user.id);
  await db.write();
  res.cookie("token", signToken(user), COOKIE_OPTS);
  res.clearCookie("guest_id");
  res.json({ id: user.id, email: user.email, name: user.name });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  await db.read();
  const user = db.data.users.find((u) => u.email.toLowerCase() === String(email || "").toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });
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
