// Forwards requests to the local Ollama daemon while rewriting the Host header.
//
// Ollama rejects requests whose Host header is not localhost (DNS rebinding
// protection). A public tunnel such as Cloudflare forwards the public hostname,
// so Ollama answers 403 and the deployment cannot use the local models. This
// proxy sits between the tunnel and Ollama and restores the localhost Host
// header. Run it, then point the tunnel at it instead of at Ollama directly:
//
//   node server/scripts/ollama-host-proxy.js
//   cloudflared tunnel --url http://localhost:11435
//
// The deployment then sets OLLAMA_BASE_URL to the trycloudflare.com URL.
import http from "http";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const PROXY_PORT = Number(process.env.PROXY_PORT || 11435);

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` };
  const upstream = http.request(
    { host: OLLAMA_HOST, port: OLLAMA_PORT, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Ollama proxy error: ${e.message}` }));
  });
  req.pipe(upstream);
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`Ollama host-header proxy listening on http://127.0.0.1:${PROXY_PORT} -> ${OLLAMA_HOST}:${OLLAMA_PORT}`);
});
