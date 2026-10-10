# officeace2api

Turn a model gateway into a full **OpenAI-compatible API** with a built-in web console.

**Zero dependencies** — Node.js built-in modules only. No `npm install` needed.

> ⚠️ **Prerequisite**: The **OfficeAce desktop client** must be installed and signed in.
> This project is a companion service to that client and reads its credential files.
> **Without the desktop client, account authorization fails.**

![Console](docs/panel-accounts.png)

---

## 1. Features

### API layer

| Endpoint | Description |
|---|---|
| `/v1/chat/completions` | Streaming SSE + non-streaming |
| `/v1/models` | Model list |
| Function Calling | Tool calls passed through untouched |
| `reasoning_content` | Chain-of-thought for reasoning models, returned in a separate field |
| `usage` | Token accounting (including `reasoning_tokens`) |

Works with any client that accepts a custom Base URL: Cherry Studio, NextChat, LobeChat,
Cline, Roo Code, Continue, Cursor, Dify, immersive translation extensions, the OpenAI SDK, etc.

### Web console (`http://127.0.0.1:7864/admin`)

> The console is protected by a **panel token** (generated automatically on first start —
> see "Quick start" below). Open it with `?token=` in the URL, or send an
> `x-admin-token` header. To disable auth for local-only use, set `admin.token`
> to `""` in `config.json`. (`open-panel.cmd` appends the token for you.)

**Tip for local use:** bookmark the tokenized URL. The front-end reads the token from the
URL and attaches it to every request, so a bookmark takes you straight in.

| Menu | What it does |
|---|---|
| **Account pool** | Credentials, remaining credits and health for every account; test / rename / disable / delete |
| **Usage** | Request counts and token consumption, grouped by model and by API key |
| **Credit breakdown** | How many credits each account has left — queried from the cloud, not estimated |
| **Models & tiers** | Model list, aliases, hiding, manual entries; includes a built-in test bench |
| **Integration info** | Copy-paste snippets (JSON / `.env` / curl) for each client |
| **Runtime logs** | Live logs with level filtering |
| **Settings** | Change port, API keys, upstream, refresh interval — written back to `config.json` |

### Automation

- **Multi-account pool** — round-robin, rate-limit cooldown, credit circuit breaker (exhausted accounts are skipped)
- **Automatic credential renewal** — temporary credentials are refreshed before they expire
- **Daily check-in** — collects bonus credits on a schedule
- **Bulk registration** — auto-register and provision a batch of phone numbers (optional, needs an SMS code source)
- **Autostart + watchdog** — registers as a Windows scheduled task; the process is restarted if it dies

---

## 2. Quick start

### 2.1 Requirements

- **Windows** (the launcher scripts are batch files; the core is pure Node and can be started on
  other platforms with `node src/index.mjs`, but auto-discovery of the desktop client and DPAPI
  decryption are Windows-only)
- **Node.js >= 20**

Node is optional — if the OfficeAce desktop client is installed, the launcher will use its
bundled `<install dir>\tools\node\node.exe` (v22+). Lookup order:
`data\node.txt` → `node` on `PATH` → `<drive>:\...\OfficeAce\tools\node\node.exe`.

### 2.2 Clone

```bash
git clone https://github.com/Q-shuang-dot/officeace2api.git
cd officeace2api
```

The first start generates `config.json` and the `data\` directory automatically.

### 2.3 Start

Double-click **`start.cmd`** (temporary start; closing the window does not kill it):

```
[OK] service is up

  OpenAI base : http://127.0.0.1:7864/v1
  Admin panel : http://127.0.0.1:7864/admin?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  API key     : see "apiKeys" in config.json  (default: sk-officeace)
  Log file    : logs\server.log
```

> The `?token=` string is the **panel token**, generated on first start and stored in
> `config.json`. Keep it — without it the console returns 401. (`open-panel.cmd`
> appends it automatically.)

> ⚠️ **Do not run `node src/index.mjs` in a terminal and then close the window** — the
> process dies with the window and the browser shows `ERR_CONNECTION_REFUSED`. Use
> `start.cmd` instead.

### 2.4 Add an account (**this is required**)

**Check the "Account pool" page first** — it may already be populated:

- **OfficeAce desktop client installed** (regular or portable): the service discovers its
  accounts on startup and lists them in the pool — **no manual step needed**. Searched
  locations: `~\.office-claw\`, `<drive>:\软件\OfficeAce\.office-claw`, and whatever
  `OFFICEACE_INSTALL_DIR` points to. Note that the latter are **absolute paths and do not
  follow `USERPROFILE`**.
- **Client not installed**: the pool is empty and **the proxy cannot forward any request**.
  Use one of the three options below.

**Option A — reuse an already signed-in OfficeAce client (recommended)**

> ⚠️ **The OfficeAce desktop client must be installed.** Without it, "sign in with another
> account" in the console fails with an authorization error.

Sign in to the client, send one message, then double-click `stop.cmd` followed by
`start.cmd` — the service extracts the credentials automatically.

**Option B — sign in a new account through the console**

If the client is installed but the service did not discover any account:

Open the console → **Account pool** → click **"Sign in with another account"** → sign in
with your own account in the browser.

> 💡 This flow requires a running OfficeAce desktop client to handle the OAuth callback.

**Option C — manual import (fallback)**

If you already have a `baseUrl` + `Authorization`, open **Account pool** → **Import account**
and paste them in.

> The console always shows each account's **remaining credits** and health. Accounts that run
> out of credits are skipped automatically (credit circuit breaker).

### 2.5 Open the console

Double-click **`open-panel.cmd`** — it derives the URL (including the panel token) from
`config.json` and starts the service first if it is not running.

> ⚠️ Use **`127.0.0.1`**, not `localhost`. The service binds IPv4 only, and browsers resolve
> `localhost` to IPv6 `[::1]` first, where nothing is listening → connection refused.

### 2.6 Point your client at it

| Field | Value |
|---|---|
| Base URL | `http://127.0.0.1:7864/v1` |
| API Key | `sk-officeace` (**change this in Settings before sharing the service**) |
| Model | Click "Integration info" to copy, or see `/v1/models` |

---

## 3. Running in the background (autostart)

Double-click **`install-autostart.cmd`** to register the Windows scheduled task `officeace2api`:

```
[OK] scheduled task 'officeace2api' installed
[OK] will start automatically at every logon
[OK] running: http://127.0.0.1:7864/healthz
```

It needs no console window: closing windows, logging off and rebooting will not stop it, and
it starts on every logon. A watchdog (`tools\watchdog.ps1`) restarts the process whenever it dies.

Double-click **`remove-autostart.cmd`** to uninstall.

### Common commands

| Double-click | Purpose |
|---|---|
| `start.cmd` | Start (uses the scheduled task if installed, otherwise launches in the background) |
| `stop.cmd` | Stop |
| `status.cmd` | Show health and the model list |
| `open-panel.cmd` | Open the console (starts the service first if needed) |
| `install-autostart.cmd` | Install autostart |
| `remove-autostart.cmd` | Remove autostart |

---

## 4. Ways to add accounts

Four ways. The first one covers everyday use.

### A. Self-service sign-in in the console (recommended)

Console → **Account pool** → top right **Import account** → dialog:

| Button | When to use |
|---|---|
| **Start sign-in** | Renew authorization for an **existing** account (cloud session is still alive, no password needed) |
| **Sign in with another account** | **Add a new account** (signs out first, then lets you sign in) |

After signing in in the browser, the account lands in the pool by itself — no extra clicks.

### B. Move an account from another machine

If you have a machine that is already signed in and do not want to sign in again:

Copy `api_base` and `custom_headers.Authorization` from that machine's `models.json` into
**Import account → Move account from another machine**.

### C. Bulk registration

Console → **Settings → Authorization / Registration → Bulk registration**: give it a batch of
phone numbers and the service registers Huawei Cloud accounts, provisions them and adds them
to the pool. Requires an SMS verification-code source (manual entry or an HTTP endpoint).

### D. Auto-discover accounts already signed in on this machine

If the OfficeAce desktop client was installed and signed in on this machine, its accounts are
pulled into the pool on startup — **zero configuration**.

---

## 5. Is the OfficeAce client mandatory?

**No.** Three scenarios:

| Your situation | Need the desktop client? | What to do |
|---|---|---|
| OfficeAce installed and signed in | No extra step | Works on startup, auto-discovered |
| No OfficeAce, but you have a Huawei Cloud account | **Not needed** | Console → Import account → self-service sign-in (option A above) |
| Only proxying **another** OpenAI-compatible service | **Not needed**, no Huawei account either | Set `upstream.baseUrl` + `upstream.authorization` in `config.json` |

The third case turns it into a generic OpenAI-compatible reverse proxy:

```json
{
  "upstream": {
    "autoDiscover": false,
    "baseUrl": "https://your-upstream/v1",
    "authorization": "Bearer sk-xxxxxxxx"
  }
}
```

The Settings page in the console exposes the same two fields (manual upstream URL /
manual auth header) — fill them in and save.

---

## 6. FAQ

**Q: The browser cannot connect — `ERR_CONNECTION_REFUSED`.**
Use `127.0.0.1:7864`, not `localhost:7864`. The service binds IPv4 only and browsers try IPv6 first.

**Q: `status.cmd` says the service is down.**
Double-click `start.cmd`, or delegate to the scheduled task with `install-autostart.cmd`.
Logs are in `logs\server.log`.

**Q: The client returns an empty body with HTTP 200.**
The upstream treats `max_tokens` as the budget for *reasoning + answer*. A reasoning model
spends the whole budget on its chain of thought and leaves nothing for the answer. Set
`models.minMaxTokens` in `config.json` (default 1024) so the service tops up the budget.
See the [technical notes](docs/技术笔记.md).

**Q: Some models in the list do not respond.**
The upstream catalog is not the same as per-account entitlements. Unavailable models return
400 `model_not_available`. Details in the [technical notes](docs/技术笔记.md).

**Q: Do I need to restart after editing `config.json`?**
Port and bind address require a restart; everything else takes effect when you click Save in
the console.

**Q: Where is the data stored? Is anything uploaded?**
Everything stays local: `data\` (account state, usage, credit history) and `logs\`. Both are
in `.gitignore` and never enter the repository. The service performs no external reporting.

---

## 7. Directory layout

```
officeace2api/
├── start.cmd / stop.cmd / status.cmd      start, stop, inspect
├── install-autostart.cmd                  install as autostart
├── open-panel.cmd                         open the console
├── config.json                            config (auto-generated, not tracked)
├── src/                                   the service
│   ├── index.mjs       entry point
│   ├── server.mjs      HTTP routing and API implementation
│   ├── pool.mjs        account pool and rotation
│   ├── quota.mjs       credit queries / check-in / circuit breaker
│   ├── refresh.mjs     automatic credential renewal
│   ├── admin.html      console front-end (single file)
│   └── ...
├── tools/                                 diagnostics, regression tests, watchdog
├── docs/                                  console screenshots + technical notes
├── data/                                  runtime data (not tracked)
└── logs/                                  logs (not tracked)
```

---

## 8. More

- **[docs/技术笔记.md](docs/技术笔记.md)** (Chinese) — implementation details, the OAuth/PKCE
  chain, DPAPI decryption, V11-HMAC-SHA256 signing, the reasoning-model token budget, and the
  pitfalls encountered along the way.
- `node tools/smoke-test.mjs` — end-to-end self-test
- `node tools/test-admin.mjs` — console API self-test (223 cases)
- `node tools/test-max-tokens.mjs` — unit tests for the reasoning-budget rewrite rules (47 cases)
- `node tools/test-model-probe.mjs` — unit tests for model availability probing (41 cases)
- `node tools/stress-deep41.mjs` — large-scale load test: long sessions / long context / high
  concurrency / mixed models (spends real credits; `--all` maxes it out)
- `node tools/diag-empty-window.mjs` — reproduce the "reasoning ate the budget, empty body" window
- `node tools/diag-upstream-limits.mjs` — probe the two upstream limits: 5000 messages / token window
- `node tools/diag-body-too-large.mjs` — oversized request bodies must return 413, not 429
- `node tools/diag-admin-auth.mjs` — verify console auth (no token / right token / wrong token, plus the `?token=` path)
- `node tools/diag-portability.mjs` — inspect credential shapes in `data/` (can they be copied to another machine?)
- `node tools/diag-local-daily.mjs` — **daily health check**: real endpoints behind all seven menus
- `node tools/diag-panel-api.mjs` — **extract and actually run the panel's `api()`** (both `{json:{...}}` and `{json:true, body}` forms)
- `node tools/diag-fresh-clone.mjs` — **simulate a fresh clone**: copy only git-tracked files to a clean directory and start the service
- `node tools/diag-ghost-accounts.mjs` — prove that `labels` cannot create "ghost accounts"

---

## Contributing

Contributions are welcome. Three paths:

- **Just have a question or want to chat** → use
  [Discussions](https://github.com/Q-shuang-dot/officeace2api/discussions).
- **Report a bug or suggest a feature** → open an
  [issue](https://github.com/Q-shuang-dot/officeace2api/issues/new/choose).
  Templates are provided and no coding is required.
- **Submit code** → read **[CONTRIBUTING.md](CONTRIBUTING.md)** first (Chinese),
  then fork, branch and open a pull request.

> ⚠️ Three hard rules before you start: **zero npm dependencies**, **`.cmd` files must be
> pure ASCII with no BOM**, and **`data/` and `logs/` must never be committed**.
> See section 1 of CONTRIBUTING.md.

> 🔐 For **security vulnerabilities** (credential leaks, auth bypass, etc.) use
> [private vulnerability reporting](https://github.com/Q-shuang-dot/officeace2api/security/advisories/new)
> instead of a public issue.

---

## Other languages

- [简体中文](README.md) (default)

## License

[MIT](LICENSE)
