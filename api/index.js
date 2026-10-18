import app, { ready } from "../server/src/app.js";
import { warmSample } from "../server/src/sample.js";

// Best effort: a serverless instance can be frozen between requests, so the
// compile started here may not finish before the first answer goes out. Every
// route that needs the sample program also asks for it, so this only makes the
// first visitor's screen faster; it is never what makes it correct.
ready.then(() => warmSample()).catch(() => {});

export default app;
