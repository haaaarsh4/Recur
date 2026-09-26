import app, { ready, servingClient } from "./app.js";

const PORT = process.env.PORT || 8787;

ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Recur server listening on http://localhost:${PORT}`);
    console.log(servingClient ? "Serving the built client from client/dist." : "API only: no built client found at client/dist.");
    console.log("Default model backend: Ollama Local");
  });
});
