# mcp-voice-simulator

> **Unofficial, community-built, not affiliated with or endorsed by Amazon.**
> Amazon's own docs state that ["Category SDK and MCP Toolkit are available to
> select partners only"](https://developer.amazon.com/docs/alexaplus/add-ons/home.html) —
> there is no public Alexa AI CLI, add-on registration, or device simulator
> available to most developers, including hackathon participants building for
> the Alexa+ track. This project does not use, wrap, or reverse-engineer any
> private Amazon tool or access. It's a clean-room implementation built only
> from published specs: MCP's own [Streamable HTTP
> transport](https://modelcontextprotocol.io/docs/latest/getting-started/intro),
> [OAuth 2.1](https://oauth.net/2.1/), PKCE
> ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), Protected Resource
> Metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), Authorization
> Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)), and
> Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)).

## What it does

Stands in for Alexa+ as the **MCP client**, in the same order a real Alexa+
integration would:

1. **Account linking** — OAuth 2.1 + PKCE, discovered via RFC 9728/8414 against
   *any* spec-compliant MCP server, not one hardcoded login flow. A human
   completes login in their own browser (the standard "loopback" pattern —
   the same one `gcloud auth login` and similar CLIs use), so it works
   whatever your server's login screen looks like.
2. **Tool discovery** — `tools/list` over MCP's Streamable HTTP transport.
3. **Per utterance** — pick a tool, call it, and speak the result back, via a
   pluggable **brain**.

Three brains ship ready to use, needing no per-server tuning because they pick
tools from whatever `tools/list` returns:

- **`createClaudeBrain`** — an Anthropic Messages API tool-use loop
  (needs `ANTHROPIC_API_KEY` and the peer dependency `@anthropic-ai/sdk`)
- **`createCursorBrain`** — a Cursor agent restricted to your server's MCP
  tools, so Cursor itself is the MCP client
  (needs `CURSOR_API_KEY` and the peer dependency `@cursor/sdk`)
- **`createBedrockBrain`** — an Amazon Bedrock Converse API tool-use loop, so
  any Bedrock model with tool use can drive it
  (needs AWS credentials and the peer dependency `@aws-sdk/client-bedrock-runtime`,
  see [Amazon Bedrock](#amazon-bedrock))

There's no built-in "no API key" brain — picking a tool from open-ended
natural language needs an LLM unless you write one for your own specific
tools. `examples/scripted-brain.ts` shows exactly that pattern; copy it for
yours.

![Demo of the simulator against a sample MCP server](https://raw.githubusercontent.com/AlSayedGamal/mcp-voice-simulator/main/docs/demo.gif)

The clip is recorded against a **fictional** sample task tracker (`npm run demo`),
not a real application's API. It walks through account-linked status, tool
discovery (🖼 marks tools that declare a `ui://` view), a typed utterance, the
thinking ring, MCP call traces, the MCP Apps view on the device screen,
`tools/call` from the view, `ui/message` from the view, Confirm, and the
screen-shape picker.

To re-record: `npm run demo:record` (needs Playwright Chromium; writes `docs/demo.gif` and `docs/demo.mp4`).

## Quickstart (CLI)

```bash
npm install -g mcp-voice-simulator
npm install @anthropic-ai/sdk   # or @cursor/sdk, whichever brain you want

MCP_URL=https://your-server.example.com/mcp \
ANTHROPIC_API_KEY=sk-ant-... \
mcp-voice-simulator
```

Open the printed `http://127.0.0.1:8790` URL. It links an account against
your server, discovers its tools, and lets you type or speak utterances.

Linking is done in your browser: the page shows a **Link account** button with
a countdown (the URL is also printed in the terminal). If the login isn't
finished in time, the page says so and offers **Try again**, which starts a
new attempt. A failed attempt is never kept, so reloading the page also starts
a fresh one.

If your server doesn't implement RFC 7591 dynamic client registration (most
don't — it's optional even in a fully spec-compliant setup), set
`MCP_CLIENT_ID` to a pre-configured client id instead. If you already have a
bearer token and want to skip account linking entirely, set
`MCP_BEARER_TOKEN`.

| Env var | Purpose |
| --- | --- |
| `MCP_URL` | required — the MCP server's endpoint |
| `MCP_CLIENT_ID` | OAuth client id, if your server has no dynamic registration |
| `MCP_BEARER_TOKEN` | skip account linking entirely |
| `SIM_PORT` | default `8790` |
| `SIM_LINK_TIMEOUT_MS` | how long to wait for you to finish logging in, in milliseconds (default `300000`, 5 minutes). Servers that make you connect several providers on first use can need every minute of it |
| `SIM_UI`, `SIM_SANDBOX_PORT` | MCP Apps views, see [On-screen views](#on-screen-views-mcp-apps) |
| `SIM_TTS` and `ELEVENLABS_*` | optional server-side voice, see [Voice](#voice-text-to-speech) |
| `SIM_HOST`, `SIM_ALLOWED_HOSTS`, `SIM_PUBLIC_ORIGIN`, `SIM_ACCESS_TOKEN` | reach the page from a phone, see [On a phone](#on-a-phone-location-camera-https) |
| `SIM_BRAIN` | force `claude`, `cursor` or `bedrock` (default: cursor if `CURSOR_API_KEY` is set, else claude; Bedrock is never picked on its own) |
| `ANTHROPIC_API_KEY`, `SIM_MODEL` | for the Claude brain (`SIM_MODEL` default `claude-sonnet-5`) |
| `CURSOR_API_KEY`, `SIM_CURSOR_MODEL` | for the Cursor brain (`SIM_CURSOR_MODEL` default `composer-2.5`) |
| `AWS_REGION`, `AWS_PROFILE`, `SIM_BEDROCK_MODEL` | for the Bedrock brain, see [Amazon Bedrock](#amazon-bedrock) |

## Amazon Bedrock

`SIM_BRAIN=bedrock` drives the simulator with a model on Amazon Bedrock through
the [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html),
which has one tool-use shape for every model that supports tools, so switching
models is a config change.

```bash
npm install @aws-sdk/client-bedrock-runtime

SIM_BRAIN=bedrock AWS_PROFILE=my-bedrock-profile AWS_REGION=us-east-1 MCP_URL=https://your-server.example.com/mcp mcp-voice-simulator
```

Credentials come from the AWS SDK's standard chain (`AWS_PROFILE`, SSO,
environment variables, an instance role), never from the simulator's own
config. The identity needs `bedrock:InvokeModel` on the model (and on the
inference profile, if you use one), and the model must be enabled for your
account in the Bedrock console.

| Env var | Purpose |
| --- | --- |
| `SIM_BRAIN` | `bedrock` |
| `AWS_REGION` | the Bedrock region, e.g. `us-east-1` (or set one in the profile's config) |
| `AWS_PROFILE` | optional; a named profile from `~/.aws/config` |
| `SIM_BEDROCK_MODEL` | model or inference profile id (default `us.anthropic.claude-sonnet-4-5-20250929-v1:0`) |

A model being *listed* for your account doesn't mean you can call it: some
return `AccessDeniedException` until access is granted. Try a one-off call (for
example `aws bedrock-runtime converse --model-id <id> --messages
'[{"role":"user","content":[{"text":"hi"}]}]'`) before switching.

How it maps MCP onto Converse:

- Each `tools/list` entry becomes a `toolSpec`, its `inputSchema` passed as-is
  as `inputSchema.json`. Bedrock tool names must match `[a-zA-Z0-9_-]{1,64}`, so
  other characters become `_` (and are mapped back for `tools/call`); a missing
  description falls back to the title or name.
- The loop runs model → `toolUse` → `tools/call` → `toolResult` → model until the
  model answers. `isError` results and JSON-RPC errors go back to the model as
  `status: "error"` so it can say so or correct itself; a dropped connection is
  thrown, so the server relinks.
- At most `maxSteps` tool calls per turn (default 8); after the last one the
  model is told to answer with what it has.
- The trace has each call's full result, so [MCP Apps views](#on-screen-views-mcp-apps) work.
- **Mutating tools need a user turn in between.** Tools not annotated
  `readOnlyHint: true` go through a confirmation gate: the model's first call is
  held (not sent to the server) and the model is told to ask the user; only the
  identical call on the user's next turn runs. For tools with a `confirm` or
  `dryRun` parameter, the preview call counts as the read-back, so "yes" runs the
  confirming call without asking twice. A held call also shows the **Confirm** /
  **Cancel** buttons. Your server should still enforce its own rules; this stops
  the model from acting on its own in one step, not a determined user.

```ts
import { McpSessionManager, createServer, createBedrockBrain } from "mcp-voice-simulator";

const sessionManager = new McpSessionManager({ mcpUrl, bearerToken: process.env.MCP_BEARER_TOKEN });
const brain = createBedrockBrain({
  session: () => sessionManager.ensureSession(),
  region: "us-east-1",
  model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  systemPrompt: "You are ...",
  maxSteps: 8,
  // Optional: exempt a tool from confirmation, or require it for a read-only one.
  classifyToolCall: (tool) => (tool?.name === "attach_photo" ? "run" : undefined),
});
createServer({ sessionManager, brain });
```

## On-screen views (MCP Apps)

MCP servers can return a screen next to their spoken reply: a tool declares `_meta.ui.resourceUri: "ui://…"`, the host fetches that HTML resource and shows it in a sandboxed iframe, and the view talks back over `postMessage` ([MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/)). Alexa+'s MCP Toolkit docs say it supports MCP Apps through a webview. The simulator hosts these views on its device screen, so you can try yours:

- **Advertises support** (`extensions["io.modelcontextprotocol/ui"]`) when it connects, so servers that only expose view-enabled tools to capable clients show them.
- **Shows the view** of the last view-bearing tool call in a turn, fed `tool-input` then `tool-result` like a spec-compliant host. The Tools card marks tools that declare a view (🖼).
- **Answers the view's calls the way a host must:** `tools/call` only for tools whose `_meta.ui.visibility` includes `"app"` (anything else is refused, as the spec requires), `ui/message` becomes a new utterance to the brain (this is how a "Modify" button hands a change back to the assistant), and `ui/open-link` opens `https:` links only, after a confirm.
- **Enforces the spec's Content-Security-Policy** (deny-by-default, plus whatever the resource declares in `_meta.ui.csp`) and shows a note in the log when a view breaks it, e.g. a `fetch` to an origin it didn't declare.
- **Runs the view in the spec's two-origin sandbox:** the page is on `127.0.0.1:<port>` and a sandbox proxy is on `127.0.0.1:<port + 1>`, so the view can't reach the simulator's own origin or API.
- **Shows a note instead of failing** when a declared view can't be shown (wrong MIME type, resource missing).

| Env var | Purpose |
| --- | --- |
| `SIM_UI` | `on` (default) or `off`. Off advertises nothing and shows text only, which is what a host without MCP Apps does, so use it to test your server's text fallback. |
| `SIM_SANDBOX_PORT` | the sandbox proxy's port (default `SIM_PORT + 1`) |

**What this is and isn't.** It implements the MCP Apps *spec* host. It does not model Alexa's own webview: the Alexa docs only say a view renders "in the conversation view", so what Alexa+ enforces beyond the spec is unknown to us. The screen-shape picker under the device is for trying a view at different sizes, not a claim about any real device.

**Brain support.** With the Claude brain the simulator makes the tool calls and has the full result, so views work. The Cursor brain makes tool calls itself and doesn't hand back the full result; the simulator will not re-call a tool to get it (a mutating tool would repeat its side effects), so with Cursor it shows a note that the view can't be shown.

## Voice (text-to-speech)

By default the simulator speaks replies with your browser's built-in voice, which varies a lot by OS and browser. To use a better one, opt in to a server-side provider. **ElevenLabs** is built in:

```bash
SIM_TTS=elevenlabs \
ELEVENLABS_API_KEY=... \
ELEVENLABS_VOICE_ID=... \
MCP_URL=https://your-server.example.com/mcp ANTHROPIC_API_KEY=sk-ant-... \
mcp-voice-simulator
```

Find a voice id in the ElevenLabs voice library. The key stays in the Node process; the page only ever asks the local server for audio.

| Env var | Purpose |
| --- | --- |
| `SIM_TTS` | `browser` (default) or `elevenlabs`. Deliberately opt-in: a lone `ELEVENLABS_API_KEY` only prints a hint. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | required when `SIM_TTS=elevenlabs` |
| `ELEVENLABS_MODEL` | optional; ElevenLabs' own default model is used when unset |
| `ELEVENLABS_OUTPUT_FORMAT` | default `mp3_44100_128`; must be `mp3_*`, `opus_*` or `wav_*` (what a browser `<audio>` can play) |
| `ELEVENLABS_VOICE_SETTINGS` | optional JSON, e.g. `{"stability":0.5,"speed":1.1}` |
| `ELEVENLABS_BASE_URL` | optional; for a proxy or a test double |
| `SIM_TTS_MAX_CHARS` | longest reply sent to the provider (default 500, cut at a sentence end) |
| `SIM_TTS_CACHE` | how many synthesized clips to keep in memory (default 20; `0` disables), so a repeated reply isn't paid for twice |

**Privacy and cost.** With a server voice on, the text of each reply is sent to the provider. That text can include data your MCP server returned (ticket titles, meeting notes, names), which is why it's off by default. ElevenLabs bills by character; the cap and cache reduce accidental spend but are not a budget.

**If the provider fails** (bad key, out of credits, no network), that reply is spoken with the browser voice instead, the Connection card says why once, and the conversation carries on. After a bad-credentials error the page stops calling the provider until reload.

Add your own provider by implementing `TtsProvider` (one method) and passing it to `createServer`:

```ts
import { createServer, TtsError, type TtsProvider } from "mcp-voice-simulator";

const myVoice: TtsProvider = {
  name: "my-voice",
  cacheKey: "voice-a", // anything besides the text that changes the audio
  async synthesize(text, { signal }) {
    const res = await fetch("https://tts.example.com/say", { method: "POST", body: text, signal });
    if (!res.ok || !res.body) throw new TtsError("server", `TTS failed (${res.status})`, res.status);
    return { audio: res.body, contentType: "audio/mpeg" };
  },
};

createServer({ sessionManager, brain, tts: myVoice });
```

## On a phone (location, camera, HTTPS)

Voice assistants are often used on the move, and some requests depend on where the user is or on a photo they just
took. The page can send both as [turn context](#turn-context), and it works on a phone browser (tested on Android
Chrome): big tap targets, the mic at the bottom where a thumb reaches it, and a ☀ button for high contrast in daylight.

- **📍 Location** (opt-in): while on, the page watches the device's position with high accuracy and sends the latest
  fix with every utterance as `context.location`:
  `{ latitude, longitude, accuracyMeters, timestamp, ageSeconds }`. The device row shows the fix, its accuracy and
  age, warns when it's worse than 50 m or older than 60 s, and says so plainly when there's no fix or the permission
  was denied. The choice is remembered on that device.
- **📷 Photo** (shown only when the host app provides an `onPhoto` hook): takes a photo with the back camera
  (`capture="environment"`); 🖼 picks an existing one instead. The page posts it to the simulator, **never to the MCP
  server directly**; the hook stores it and returns an id, which goes in the next utterance's `context.photos`. The
  hook can also return an `utterance` the page then sends straight away (e.g. "I just took a photo."), so a photo can
  trigger a turn on its own. The simulator accepts JPEG, PNG and WebP up to 10 MB by default, checked against the
  file's bytes, not its name or declared type.

```ts
createServer({
  sessionManager,
  brain,
  // Credentials for your storage stay in this process; the browser only gets the id.
  onPhoto: async ({ data, contentType }) => ({ id: await myStorage.put(data, contentType) }),
  photoMaxBytes: 8 * 1024 * 1024,           // optional
  photoTypes: ["image/jpeg", "image/png"], // optional
});
```

### HTTPS and access

Phone browsers only allow the microphone, location and camera on `https://` pages (or `localhost`), so use an HTTPS
tunnel to the simulator, for example a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(no account needed). The simulator keeps listening on 127.0.0.1; only the tunnel reaches it.

```bash
# 1. Start the tunnel and note the https://<random>.trycloudflare.com URL it prints.
cloudflared tunnel --url http://127.0.0.1:8790

# 2. Start the simulator, allowing exactly that origin and setting an access token.
SIM_PUBLIC_ORIGIN=https://<random>.trycloudflare.com \
SIM_ACCESS_TOKEN="$(openssl rand -base64 24)" \
MCP_URL=... mcp-voice-simulator
```

Open the tunnel URL on the phone and enter the access token once. Then allow the microphone and, if you use them,
location and the camera when the browser asks.

| Env var | Purpose |
| --- | --- |
| `SIM_HOST` | address to listen on (default `127.0.0.1`). Anything else, e.g. `0.0.0.0` for the LAN, exposes the page. |
| `SIM_PUBLIC_ORIGIN` | the tunnel's origin, e.g. `https://abc.trycloudflare.com`. Its host is accepted as `Host` and the origin as `Origin`, exactly; no wildcards. |
| `SIM_ALLOWED_HOSTS` | extra `Host` values, comma-separated, exactly as the browser sends them (`192.168.1.20:8790`). |
| `SIM_ACCESS_TOKEN` | the secret the page asks for, at least 16 characters. **Required** whenever any of the three above exposes the page: the simulator refuses to start without it. Optional on loopback, and enforced if set. |

**Security notes.**
- The defaults are unchanged: 127.0.0.1 only, loopback `Host` and `Origin` only, no token.
- The DNS-rebinding and CSRF guards stay on when exposed; the allow-lists are only extended by what you configure.
  Every POST still needs JSON (or an allowed image type for the photo upload), neither of which a cross-origin page can
  send without a CORS preflight, and the simulator sends no CORS headers.
- The access token is checked in constant time, and 10 wrong tries in 10 minutes lock entry for the rest of that
  window. A right one gets a cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on an https origin, 12 hours) holding an
  expiry and an HMAC of it keyed by the token: no token in the cookie, nothing stored server-side, and changing the
  token signs everyone out.
- Anyone with the tunnel URL **and** the token can use your linked account and your LLM credits. Use a long random
  token, stop the tunnel when you're done, and don't share either in places that get indexed.
- JSON request bodies are capped at 1 MB and photos at their limit, so an exposed simulator can't be made to buffer
  huge bodies.

### MCP Apps views on a phone (not supported yet)

Views run in a sandbox on a second origin, `http://127.0.0.1:<port + 1>`, which only exists on the computer running
the simulator. Through a tunnel the page reports views as unavailable ("not on this device") and shows text only.
Supporting them would need:

1. A second tunnel for the sandbox port, and a setting for its public origin (say `SIM_SANDBOX_PUBLIC_ORIGIN`) that
   `/api/status` reports as `sandboxOrigin` instead of the loopback one. It must be a different origin from the page,
   as the spec requires, and https, or the browser blocks it as mixed content.
2. The sandbox's host check (`allowedHosts` in `ui/sandbox.ts`) and its referrer check (only loopback page origins
   today) extended to exactly the configured tunnel host and page origin.
3. A decision on access control for the sandbox: it serves only the static proxy page, and views get their data from
   the host page over `postMessage`, so it may not need the token, but that should be checked against the view CSP.

## Programmatic API

For a custom brain, or to embed the simulator in your own app:

```ts
import { McpSessionManager, createServer, createClaudeBrain } from "mcp-voice-simulator";

const sessionManager = new McpSessionManager({ mcpUrl: "https://your-server.example.com/mcp" });
const brain = createClaudeBrain({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  session: () => sessionManager.ensureSession(),
});

createServer({ sessionManager, brain, port: 8790 });
```

Write your own brain by implementing the `Brain` interface (`turn(utterance, context?)`
→ `{ reply, trace, awaitingConfirmation? }`, optional `reset()`) — see
`examples/scripted-brain.ts` for a complete keyword-routed example needing
no LLM at all.

### Turn context

Some requests depend on what the device knows rather than what the user said:
"log a pothole **here**" needs a location, "attach **this** photo" needs the
id of the upload. Pass such facts as turn context, either from the host app
for every turn:

```ts
createServer({ sessionManager, brain, turnContext: () => ({ location: lastKnownLocation }) });
```

or from the page with a single utterance, as `POST /api/turn {"utterance": "...",
"context": {...}}` (a JSON object of at most 4 KB; its keys override the
host's). The built-in brains give it to the model ahead of the utterance,
labelled as coming from the app rather than from the user. The page itself
sends `location` and `photos` this way when those features are on (see
[On a phone](#on-a-phone-location-camera-https)); a host app can map them to
whatever its prompt expects inside its brain.

The discovery and linking pieces are exported individually too
(`discoverProtectedResource`, `discoverAuthorizationServer`,
`registerDynamicClient`, `linkAccount`, `createPkce`) if you want to build
something other than the bundled server/UI on top of them.

## Conformance checker — "will this be a drop-in replacement?"

The point of building against published specs is that a server which passes
those checks today shouldn't need to change when real `alexa-ai` access
arrives. `mcp-voice-simulator-conformance` checks your MCP server against
Alexa+ MCP Toolkit's *documented* account-linking requirements — not by
guessing, but against claims traced to specific pages, each with an honest
confidence rating (see [docs/ALEXA_AI_CONTRACT.md](./docs/ALEXA_AI_CONTRACT.md)
for the full sourcing and what this deliberately does not attempt to fake):

```bash
npx mcp-voice-simulator-conformance https://your-server.example.com/mcp
```

Checks the spec transport, that unauthenticated requests get a 401, that
your authorization server's metadata advertises PKCE S256 (Amazon states
`alexa-ai deploy` is blocked without it — the highest-confidence check here),
and that `authorization_code` is an available grant type. One additional
check (whether the 401 omits a `WWW-Authenticate` header) is marked
`advisory` rather than `documented`, because that specific detail couldn't be
independently confirmed — see the contract doc before treating it as a hard
requirement.

```ts
import { checkAlexaPlusConformance } from "mcp-voice-simulator";

const report = await checkAlexaPlusConformance("https://your-server.example.com/mcp");
if (!report.passed) console.error(report.results.filter((r) => !r.pass));
```

## Architecture

```text
public/index.html   Browser UI: device-styled screen, mic (SpeechRecognition),
                     spoken replies, tool-call trace log
                     location and photo capture, phone layout
public/access.html    Access-token prompt, served instead of the page until the token is entered
public/tts.js         The page's voice: browser speechSynthesis, or /api/tts audio
public/host.js        GENERATED browser MCP Apps host (AppBridge); source in host/
src/server.ts        HTTP API: /api/status, /api/relink, /api/turn, /api/reset, /api/tts, /api/ui/tool-call,
                     /api/photo, /api/access
src/security.ts      Host/Origin/content-type guards (DNS rebinding, CSRF), opt-in allowed hosts
src/access.ts        Access token and its signed cookie, for an exposed simulator
src/photo.ts         Photo upload checks (size, type from the bytes) and the host's onPhoto hook types
src/tts/              Text-to-speech providers (ElevenLabs), cache, route
src/ui/               MCP Apps: view resolution, CSP, sandbox proxy server, routes
host/                 Browser host source (bundled to public/host.js by scripts/build-host.mjs)
src/session.ts        Owns account linking (the pending login, its expiry, retries) + the MCP connection
src/link.ts            OAuth 2.1 + PKCE loopback flow (RFC 8252-style)
src/discovery.ts        RFC 9728 / RFC 8414 / RFC 7591 discovery
src/mcp.ts             Thin @modelcontextprotocol/client wrapper
src/brains/            Pluggable utterance -> tool-call(s) -> reply strategies,
                       plus the confirmation gate for mutating tools (confirm.ts)
src/conformance.ts     Checks a server against Alexa+'s *documented* requirements
examples/              A no-API-key scripted brain, as a pattern to copy
docs/ALEXA_AI_CONTRACT.md   Exact source + confidence behind every conformance check
```

## Origin

Extracted from a hackathon MCP server's own simulator, built for an Alexa+
track entry in an Amazon developer hackathon, after discovering the Alexa AI
CLI / MCP Toolkit isn't accessible to hackathon participants — a wall every
team in that track hits. This is the generalized, server-agnostic version.

## Contributing

Issues and PRs welcome — especially real-world reports of MCP servers whose
OAuth discovery doesn't fit the two well-known URL shapes `discovery.ts`
tries (see its doc comment), and additional brains for other model providers.

## License

[MIT](./LICENSE)
