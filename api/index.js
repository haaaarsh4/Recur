// Vercel builds every file in /api into a serverless function. This is the one
// entry it needs: it hands the app to the runtime instead of listening on a
// port, and the app itself serves the API, the built client, and the SPA
// fallback. Paths are rewritten to here in vercel.json.
import app from "../server/src/app.js";

export default app;
