import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Your session expired. Please log in again." });
  }
}

// Identity for any visitor: a signed-in user, or a temporary guest. Guests get
// a session-scoped cookie (no maxAge, so the browser drops it when the browser
// closes) and their chats are treated as disposable by the server.
function identity(req, res, next) {
  const token = req.cookies?.token;
  if (token) {
    try {
      const user = jwt.verify(token, SECRET);
      req.user = user;
      req.ownerId = user.id;
      req.isGuest = false;
      return next();
    } catch (e) {
      // Expired or invalid token: treat the visitor as a guest rather than
      // blocking the request. The stale cookie gets replaced below.
    }
  }
  let guestId = req.cookies?.guest_id;
  if (!guestId || !/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) {
    guestId = nanoid(21);
  }
  // Session cookie: deliberately no maxAge so history disappears when the
  // browser closes, matching ChatGPT-style guest chat.
  res.cookie("guest_id", guestId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  req.ownerId = "guest:" + guestId;
  req.isGuest = true;
  next();
}

export { signToken, requireAuth, identity, SECRET };
