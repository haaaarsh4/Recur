# Recur

A chat app that notices when you keep asking for the same *kind* of thing, and
offers to compile it into a small reusable tool instead of solving it from
scratch every time. This is a real two-process app: an Express + JSON-file
backend, and a React (Vite) frontend. No Claude-specific runtime, no artifact
sandbox. It is yours to run, host, and modify.

Tested end-to-end in this environment: registration, login (JWT in an
httpOnly cookie), chat creation/persistence, and error handling all verified
working. The one thing *not* verified here is a live model reply, because
this sandbox can't reach the OpenAI/Anthropic API. On your own machine it
will just work once a key is connected on the Integrations page or set in
`server/.env`.