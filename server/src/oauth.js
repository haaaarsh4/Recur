import crypto from "crypto";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { signToken } from "./middleware/auth.js";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const SERVER_ORIGIN = process.env.SERVER_ORIGIN || `http://localhost:${process.env.PORT || 8787}`;
const OAUTH_COOKIE = "oauth_state";

function providerConfig(provider) {
  const callback = `${SERVER_ORIGIN}/api/auth/${provider}/callback`;
  if (provider === "google") {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callback,
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
    };
  }
  return {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callback,
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
  };
}

function requestOrigin(req) {
  if (process.env.CLIENT_ORIGIN) return process.env.CLIENT_ORIGIN;
  try {
    return new URL(req.get("referer") || CLIENT_ORIGIN).origin;
  } catch (e) {
    return CLIENT_ORIGIN;
  }
}

function beginOAuth(req, res, provider) {
  const config = providerConfig(provider);
  const returnTo = requestOrigin(req);
  if (!config.clientId || !config.clientSecret) {
    return res.redirect(`${returnTo}/?auth_error=${encodeURIComponent(`${provider} login is not configured yet. Add its OAuth credentials to server/.env.`)}`);
  }
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie(OAUTH_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
  });
  res.cookie("oauth_return_to", returnTo, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback, response_type: "code", state });
  if (provider === "google") params.set("scope", "openid email profile");
  else params.set("scope", "read:user user:email");
  return res.redirect(`${config.authorize}?${params}`);
}

async function finishOAuth(req, res, provider) {
  const config = providerConfig(provider);
  const returnTo = req.cookies?.oauth_return_to || CLIENT_ORIGIN;
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${returnTo}/?auth_error=${encodeURIComponent("OAuth sign in was cancelled.")}`);
  if (!code || !state || !req.cookies?.[OAUTH_COOKIE] || state !== req.cookies[OAUTH_COOKIE]) {
    return res.redirect(`${returnTo}/?auth_error=${encodeURIComponent("OAuth sign in could not be verified. Please try again.")}`);
  }
  try {
    const tokenRes = await fetch(config.token, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callback,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      const reason = token.error_description || token.error || `HTTP ${tokenRes.status}`;
      throw new Error(`${provider} OAuth token exchange failed: ${reason}`);
    }
    const profile = await getProfile(provider, token.access_token);
    const providerId = `${provider}:${profile.id}`;
    await db.read();
    let user = db.data.users.find((item) => item.oauthProviderId === providerId);
    if (!user) {
      user = db.data.users.find((item) => item.email.toLowerCase() === profile.email.toLowerCase());
      if (user) {
        user.oauthProviderId = providerId;
        user.oauthProvider = provider;
      } else {
        user = { id: nanoid(), email: profile.email, name: profile.name || profile.email.split("@")[0], oauthProvider: provider, oauthProviderId: providerId, passwordHash: null, createdAt: Date.now() };
        db.data.users.push(user);
      }
    }
    adoptGuestChats(req, user.id);
    await db.write();
    res.clearCookie(OAUTH_COOKIE);
    res.clearCookie("oauth_return_to");
    res.clearCookie("guest_id");
    res.cookie("token", signToken(user), COOKIE_OPTS);
    return res.redirect(returnTo);
  } catch (e) {
    return res.redirect(`${returnTo}/?auth_error=${encodeURIComponent(e.message || "OAuth sign in failed.")}`);
  }
}

async function getProfile(provider, accessToken) {
  if (provider === "google") {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok || !data.email) throw new Error("Google did not return an email address.");
    return { id: data.sub, email: data.email, name: data.name };
  }
  const profileRes = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" } });
  const profile = await profileRes.json();
  const emailRes = await fetch("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" } });
  const emails = await emailRes.json();
  const email = emails.find((item) => item.primary && item.verified)?.email || emails.find((item) => item.verified)?.email || profile.email;
  if (!profileRes.ok || !email) throw new Error("GitHub did not return a verified email address.");
  return { id: profile.id, email, name: profile.name || profile.login };
}

function adoptGuestChats(req, userId) {
  const guestId = req.cookies?.guest_id;
  if (!guestId) return;
  for (const chat of db.data.chats) {
    if (chat.userId === `guest:${guestId}`) {
      chat.userId = userId;
      chat.guest = false;
      chat.adoptedAt = Date.now();
    }
  }
}

export { beginOAuth, finishOAuth, CLIENT_ORIGIN };
