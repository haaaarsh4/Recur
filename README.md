# Recur

Recur is a chat workspace that watches the tasks you repeat and turns them into reusable programs. Instead of solving the same kind of question from scratch every time, it notices the pattern, asks your permission once, and then builds a small dedicated program that can be matched and run again whenever a similar request appears.

The idea in one sentence: a normal chatbot answers your question, Recur answers your question and quietly asks whether the work you keep doing is worth capturing.

This repository is a complete, self-contained project. It has a Node and Express backend, a React and Vite frontend, JSON file storage, local model support through Ollama, and optional connections to hosted providers through the Integrations page. There is no hidden cloud service and nothing to sign up for beyond what you choose to connect.

## How the system thinks

Every request that reaches the backend goes through the same pipeline.

```
User request
    |
    v
Profile the task (intent, domain, task fingerprint, vector embedding)
    |
    v
Match against the tool registry
    |-- strong match found --> offer to run the existing program
    |
    v
No match? Record the request as a pending observation
    |
    v
Enough similar observations collected (3 by default)?
    |
    |-- yes --> offer to compile a reusable program
    |-- no  --> answer normally with the general model
```

The important design rule is that Recur never builds anything silently. Compilation and reuse are always offered as choices in the chat, and the user decides.

## How a reusable program is created

When you accept a compile offer, the backend runs a small compiler pipeline.

1. **Collect verified evidence.** Every request Recur has answered is stored as a pending observation together with the answer the model actually produced. Before compiling, Recur keeps only observations that have a recorded output, and it throws out any input where two different answers were recorded. Compilation is built on agreement, not on invented examples.

2. **Infer the task contract.** The model is asked to look only at the verified demonstrations and return a narrow specification: what input the program takes, what computation it performs, and what it returns. The name is validated and normalized, and placeholder or empty names are rejected.

3. **Record honest metadata.** Each program stores its specification, the verified examples it was built from, the source requests that triggered it, a dataset summary with train, validation, and test split counts, its runtime label, and its training status. If something has not been measured, the metadata says so instead of inventing a number.

4. **Grow the dataset in the background.** After the chat replies, a background job asks the model to generate additional candidate demonstrations, validates every candidate, removes duplicates, contradictions, and malformed entries, and keeps only valid examples. The initial target is 256 valid examples and the full target is 2,000. This runs asynchronously so compilation never blocks your answer.

5. **Show and answer.** You receive two messages: a program details card explaining exactly what was built, what data it was built from, and what has and has not been measured, followed by the answer to your original question produced through the new program.

6. **Deduplicate aggressively.** Before any new program is saved, the registry is rechecked for an equivalent program. Paraphrases that normalize to the same task family, such as "what is the 10th element in the Fibonacci series" and "whats the 10th number in the fibonacci series", map to the same task profile, so they reuse one program instead of creating duplicates.

## How reuse works

The next time a request arrives, Recur computes a hybrid similarity between the new task profile and every stored program. Similarity combines a 256-dimensional hashed word and bigram embedding with token aliases, intent detection, and a canonical task fingerprint. A score of 0.78 or higher triggers a reuse offer that names the program and shows its specification. If you accept, the request runs through the program, and the reply is marked in the chat as having used it.

Registry entries also track executions and total latency, so you can see which programs earn their keep.

## Where the honest line is

This project is a research prototype, and its documentation would rather draw a clear line than overclaim.

What is real today:

- Task discovery, clustering, and offer-based compilation.
- A stored program with a validated contract, verified examples, and a growing validated dataset.
- Matching and reuse across paraphrased requests.
- Execution through the program's contract, with prompt echo detection as a safety net.
- Execution and latency metrics per program.

What is not done yet:

- No separate neural network is trained. Programs currently execute as contract-guided model calls, not as task-specific weights.
- Dataset accuracy is not reported, because no trained runtime exists yet to evaluate against the held-out test split.

The UI and the program details card state this directly. The architecture was designed so that a training stage can be added later: the dataset, its splits, and the evaluation expectations already exist as data.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, Vite 5, lucide-react |
| Backend | Node.js 20+, Express 4 |
| Storage | lowdb JSON file at `server/data/db.json` |
| Models | Ollama local by default |
| Hosted providers | Google Gemini, OpenAI compatible endpoints, Anthropic, remote Ollama |
| Auth | JWT in an httpOnly cookie, guest sessions, optional Google and GitHub OAuth |
| Secret storage | AES-256-GCM encryption for integration keys |

## Project structure

```
.
├── client/                    React frontend
│   ├── src/
│   │   ├── api.js             Single fetch wrapper for all endpoints
│   │   ├── pages/
│   │   │   └── Workspace.jsx  App shell, chat switching, view routing
│   │   ├── components/
│   │   │   ├── ChatThread.jsx Messages, composer, model picker
│   │   │   ├── OfferCard.jsx  Use / compile offer cards
│   │   │   ├── ToolsPanel.jsx Tool registry with program details
│   │   │   ├── Sidebar.jsx    Pinned chats, history, navigation
│   │   │   ├── HomeView.jsx   Landing content
│   │   │   └── IntegrationsPanel.jsx Provider key management
│   │   └── styles.css         All styling in one place
├── server/                    Express backend
│   ├── src/
│   │   ├── index.js           App entry, static client hosting, health check
│   │   ├── db.js              lowdb storage and startup repair
│   │   ├── engine.js          Task pipeline, clustering, compilation, reuse
│   │   ├── embeddings.js      Task profiling and similarity
│   │   ├── llm.js             Provider calls, tiers, timeouts
│   │   ├── providers.js       Provider catalog
│   │   ├── oauth.js           Google and GitHub OAuth
│   │   ├── secrets.js         Key encryption
│   │   └── routes/            auth, chats, tools, stats, integrations
│   └── data/db.json           Created automatically on first run
└── package.json               Root scripts for install, build, and start
```

## Running it locally

Prerequisites: Node.js 20 or newer, and Ollama if you want the default local models.

```bash
# 1. Install dependencies for both apps
npm install
npm --prefix client install
npm --prefix server install

# 2. Pull the default local models
ollama pull smollm2:135m-instruct-q8_0
ollama pull qwen2.5:0.5b
ollama pull llama3.1:8b-instruct-q4_K_M

# 3. Configure the server
cp server/.env.example server/.env
# Set JWT_SECRET to a long random string. Everything else works as is.

# 4. Start both processes
npm --prefix server run dev    # API on http://localhost:8787
npm --prefix client run dev    # App on http://localhost:5173
```

Open http://localhost:5173. You can start chatting as a guest immediately; the frontend proxies API calls to the backend during development.

Try asking the same kind of question three times, for example three different palindrome checks. On the third, Recur will offer to compile the pattern into a reusable program.

## Configuration

All server configuration lives in environment variables, typically in `server/.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Server port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed browser origin for CORS and OAuth redirects |
| `JWT_SECRET` | dev fallback | Signs session tokens. Always set this in production |
| `INTEGRATION_ENCRYPTION_KEY` | falls back to `JWT_SECRET` | Encrypts stored provider keys |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Where the local Ollama daemon lives |
| `MODEL_QUICK` | `smollm2:135m-instruct-q8_0` | Model for the fast tier |
| `MODEL_DEFAULT` | `qwen2.5:0.5b` | Model for the balanced tier |
| `MODEL_COMPLEX` | `llama3.1:8b-instruct-q4_K_M` | Model for the deep tier |
| `PROGRAM_DATASET_SIZE` | `2000` | Full dataset target per program, between 500 and 10000 |

Hosted provider keys are never put in environment variables. They are added on the Integrations page in the app, encrypted with AES-256-GCM, and selected explicitly per use.

## API overview

All endpoints are under `/api`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/auth/register`, `/login`, `/logout`, `/me` | POST, POST, POST, GET | Account and session management |
| `/api/auth/google`, `/api/auth/github` | GET | Optional OAuth sign in |
| `/api/chats` | GET, POST | List and create chats |
| `/api/chats/:id` | GET, DELETE | Load or delete one chat |
| `/api/chats/:id/messages` | POST | Send a message through the task pipeline |
| `/api/chats/:id/retry` | POST | Re-answer the last request |
| `/api/chats/:chatId/offers/:messageId/resolve` | POST | Accept or decline an offer (use, create, general, clarify) |
| `/api/tools` | GET, DELETE | Tool registry; DELETE clears it |
| `/api/stats` | GET | Reuse rate and library summary |
| `/api/integrations` | GET, PUT, DELETE | Manage provider integrations |
| `/api/integrations/test` | POST | Validate a provider connection |
| `/api/health` | GET | Liveness check used by hosting platforms |

## Deploying

The server doubles as the web host. Once the client is built, Express serves `client/dist` and falls back to the app for any non API route, so the whole project runs as a single service.

The free tier of Render is the simplest path.

1. Push this repository to GitHub.
2. In Render, create a Web Service from the repo.
3. Build command: `npm --prefix client install && npm --prefix client run build && npm --prefix server install`
4. Start command: `npm --prefix server run start`
5. Health check path: `/api/health`
6. Environment variables: `NODE_ENV=production`, a long random `JWT_SECRET`, an `INTEGRATION_ENCRYPTION_KEY`, and `CLIENT_ORIGIN` set to your Render URL.

One thing to plan for: Ollama runs on your machine, not in the cloud. On hosting, either connect a hosted provider on the Integrations page after the first deploy, or expose your local Ollama through a tunnel and point `OLLAMA_BASE_URL` at it. The free tier also uses an ephemeral disk, so `db.json` resets when the service redeploys or restarts.

## A note on the research direction

The interesting question behind Recur is not the chat interface. It is whether a general model can be moved from repeatedly solving problems to discovering which problems are worth building tools for, compiling those tools, and composing them later. The dataset generation, split tracking, and evaluation placeholders in this codebase exist because that is the next stage: training the small task-specific networks the registry is already shaped to hold.
