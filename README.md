# Iris

Voice assistant for Meta Ray-Ban glasses. Runs entirely on a Mac mini — no cloud services except a Cloudflare Tunnel for the HTTPS endpoint.

## How it works

```
[Glasses web app]  ──POST /ask──▶  [Mac mini: server.js]
                                      reads Calendar.app + Reminders.app
                                      calls Ollama (local LLM)
                   ◀──Cloudflare Tunnel──▶
```

## Setup

### 1. Install dependencies

```sh
# Node
npm install

# Ollama — https://ollama.com
brew install ollama
ollama pull llama3.2

# Cloudflare Tunnel
brew install cloudflared
```

### 2. Configure environment

```sh
cp .env.example .env
# Edit .env if you want a different model or port
```

### 3. Grant privacy permissions

On first run, macOS will prompt for Calendar and Reminders access. Approve both in:

**System Settings → Privacy & Security → Calendars / Reminders**

### 4. Start the server

```sh
./start.sh
```

This starts the Express server and opens a Cloudflare Tunnel. The tunnel URL is printed in the output — looks like `https://xxxx.trycloudflare.com`.

### 5. Configure the glasses app

Open the web app on your glasses, go to **Settings**, and paste the tunnel URL into **Server URL**. Save.

## Usage

- **Talk** — press Talk (or Enter) and speak your query
- **Continue** — go back to home and keep the conversation going
- **New chat** — clear history and start fresh

The app fetches only the calendar window relevant to your query: asking about "today" fetches today's events, "this week" fetches 7 days, etc.
