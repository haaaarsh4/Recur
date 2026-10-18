import app, { ready, servingClient } from "./app.js";
import { warmSample } from "./sample.js";

const PORT = process.env.PORT || 8787;

ready.then(() => {
  // Compile the sample program in the background, so the first visitor to ask
  // for a chat list does not wait for the search. Failure here is harmless: the
  // lazy path in the chat route builds it on demand.
  warmSample()
    .then((ok) => ok && console.log("Sample program ready."))
    .catch(() => {});
  app.listen(PORT, () => {
    console.log(`Recur server listening on http://localhost:${PORT}`);
    console.log(servingClient ? "Serving the built client from client/dist." : "API only: no built client found at client/dist.");
    console.log("Default model backend: Ollama Local");
  });
});
