# HexTorq Pipeline Agent

This service runs on a managed VPS beside the existing Git Pipeline. It is the only public entry point the HexTorq Cloud Console needs on that VPS.

## Responsibilities

- Validate console requests with `X-Console-Agent-Id` and `X-Console-Agent-Key`.
- Forward console deployment requests to the existing Git Pipeline without replacing GitHub webhook handling.
- Proxy PM2 status, live logs, and allowlisted PM2 actions.
- Forward deployment events from the Git Pipeline to the HexTorq Cloud Console.

It never accepts arbitrary shell commands and does not expose `pm2 delete`.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Required environment:

```dotenv
PORT=9100
AGENT_ID=agent-id-from-console
AGENT_API_KEY=generated-agent-key
CONSOLE_URL=https://console.example.com/api
PIPELINE_URL=https://git-pipeline.example.com/git
ALLOWED_PM2_PROCESSES=R-CCTV-BE,another-process
```

`CONSOLE_URL` must include the console API prefix, for example `/api`.
`PIPELINE_URL` must include the pipeline mount prefix, for example `/git`.

## Endpoints

```text
GET  /health
GET  /pm2/status/:target
GET  /pm2/logs/:target/stream?lines=100
POST /control/pm2/:processName/start|stop|restart|reload
POST /webhook/:project
POST /console/events
```

All routes except `/health` require the console agent headers.

## Pipeline integration

The agent forwards the full console request body to the pipeline. The pipeline can use optional service metadata such as `projectKey`, `branch`, `workingDirectory`, and `pm2ProcessName` for validation and deployment history.

For deployment history and live deployment logs, configure the Git Pipeline with:

```dotenv
CONSOLE_AGENT_URL=http://127.0.0.1:9100
CONSOLE_AGENT_ID=agent-id-from-console
CONSOLE_AGENT_KEY=generated-agent-key
```

The pipeline posts these events to the agent:

```text
deployment-started
deployment-log
deployment-completed
```

The agent forwards them to:

```text
POST {CONSOLE_URL}/agents/{AGENT_ID}/events
X-Agent-Id: {AGENT_ID}
X-Agent-Key: {AGENT_API_KEY}
```

Supported event types are `deployment-started`, `deployment-log`, and `deployment-completed`. The console matches each event by `projectKey` and `runId`. A console service must be registered for the project before its events can be stored.
