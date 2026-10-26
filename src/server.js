import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const app = express();
const port = Number(process.env.PORT || 9100);
const agentId = process.env.AGENT_ID;
const agentKey = process.env.AGENT_API_KEY;
const consoleUrl = process.env.CONSOLE_URL?.replace(/\/$/, '');
const pipelineUrl = process.env.PIPELINE_URL?.replace(/\/$/, '');
const allowedProcesses = new Set((process.env.ALLOWED_PM2_PROCESSES || '').split(',').map((value) => value.trim()).filter(Boolean));

if (!agentId || !agentKey || !consoleUrl || !pipelineUrl) throw new Error('AGENT_ID, AGENT_API_KEY, CONSOLE_URL, and PIPELINE_URL are required');

app.use(helmet());
app.use(express.json({ limit: '1mb' }));

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireConsole(req, res, next) {
  if (req.headers['x-console-agent-id'] !== agentId || !safeEqual(req.headers['x-console-agent-key'], agentKey)) {
    return res.status(401).json({ message: 'Invalid console credentials' });
  }
  next();
}

function runPm2(args) {
  return new Promise((resolve) => {
    const child = spawn('pm2', args, { shell: false });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', (reason) => resolve({ ok: false, output, error: reason.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output, error, code }));
  });
}

app.get('/health', (_req, res) => res.json({ status: 'ok', agentId, allowedProcesses: allowedProcesses.size }));

app.get('/pm2/status/:target', requireConsole, async (req, res) => {
  if (!/^[a-zA-Z0-9_.-]+$/.test(req.params.target) || !allowedProcesses.has(req.params.target)) return res.status(403).json({ message: 'PM2 process is not allowed for this agent' });
  const result = await runPm2(['jlist']);
  if (!result.ok) return res.status(502).json({ message: 'Unable to read PM2 status', ...result });
  try {
    const processList = JSON.parse(result.output);
    const process = processList.find((item) => item.name === req.params.target || String(item.pm_id) === req.params.target);
    if (!process) return res.status(404).json({ message: 'PM2 process not found' });
    res.json({ name: process.name, id: process.pm_id, status: process.pm2_env?.status, uptime: process.pm2_env?.pm_uptime, restarts: process.pm2_env?.restart_time, cpu: process.monit?.cpu, memory: process.monit?.memory });
  } catch { res.status(502).json({ message: 'Invalid PM2 status response' }); }
});

app.post('/webhook/:project', requireConsole, async (req, res) => {
  try {
    const response = await fetch(`${pipelineUrl}/webhook/${encodeURIComponent(req.params.project)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.status(response.status).send(await response.text());
  } catch (error) { res.status(502).json({ message: 'Pipeline webhook forwarding failed', error: error.message }); }
});

app.get('/pm2/logs/:target/stream', requireConsole, async (req, res) => {
  try {
    if (!/^[a-zA-Z0-9_.-]+$/.test(req.params.target) || !allowedProcesses.has(req.params.target)) return res.status(403).json({ message: 'PM2 process is not allowed for this agent' });
    const response = await fetch(`${pipelineUrl}/pm2/logs/${encodeURIComponent(req.params.target)}/stream?lines=${encodeURIComponent(req.query.lines || '100')}`, { headers: { Accept: 'text/event-stream' } });
    if (!response.body) return res.status(502).json({ message: 'Pipeline log stream unavailable' });
    res.status(response.status).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const reader = response.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    res.end();
  } catch { if (!res.headersSent) res.status(502).json({ message: 'Pipeline log stream failed' }); else res.end(); }
});

app.post('/control/pm2/:processName/:action', requireConsole, async (req, res) => {
  const { processName, action } = req.params;
  const allowedActions = new Set(['start', 'stop', 'restart', 'reload']);
  if (!allowedActions.has(action)) return res.status(400).json({ message: 'Unsupported PM2 action' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(processName) || !allowedProcesses.has(processName)) return res.status(403).json({ message: 'PM2 process is not allowed for this agent' });
  const result = await runPm2([action, processName, ...(action === 'restart' || action === 'reload' ? ['--update-env'] : [])]);
  if (!result.ok) return res.status(502).json({ message: 'PM2 action failed', ...result });
  res.json({ ok: true, action, processName, output: result.output });
});

app.post('/console/events', requireConsole, async (req, res) => {
  try {
    const response = await fetch(`${consoleUrl}/agents/${encodeURIComponent(agentId)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Id': agentId, 'X-Agent-Key': agentKey }, body: JSON.stringify(req.body) });
    res.status(response.status).send(await response.text());
  } catch (error) { res.status(502).json({ message: 'Console event delivery failed', error: error.message }); }
});

app.listen(port, () => console.log(`HexTorq pipeline agent listening on port ${port}`));
