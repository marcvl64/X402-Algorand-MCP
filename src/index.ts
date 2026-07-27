#!/usr/bin/env node
/**
 * Entry point. Serves Streamable HTTP by default (remote deployment) and stdio
 * when MCP_TRANSPORT=stdio (local development against a desktop MCP client).
 */

import { randomUUID } from 'node:crypto';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';

import { loadConfig } from './config.js';
import { createDeps, createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const deps = createDeps(config);
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout is the transport — diagnostics must go to stderr.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
}

async function runHttp(): Promise<void> {
  const config = loadConfig();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // One transport per MCP session. A prepared payment is held in memory until
  // its signatures arrive, so a session must keep hitting the same instance —
  // run a single instance, or use sticky sessions behind a load balancer.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // Service description. Without this, `/` 404s and anything probing the root —
  // uptime checks, platform smoke tests, a human pasting the URL — reports the
  // deployment as broken while it is in fact healthy.
  app.get('/', (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description:
        'Discover x402 payment-gated endpoints on Algorand and pay for them. Holds no keys.',
      protocol: 'Model Context Protocol',
      transport: 'streamable-http',
      endpoints: {
        mcp: '/mcp',
        health: '/health',
      },
      repository: 'https://github.com/marcvl64/X402-Algorand-MCP',
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
        id: null,
      });
      return;
    }

    const deps = createDeps(config);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      deps.pending.clear('MCP session closed before signatures were submitted');
    };

    await createServer(deps).connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET opens the server-to-client SSE stream; DELETE ends the session.
  const bySession = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Unknown or missing mcp-session-id');
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  await new Promise<void>((resolve) => {
    const httpServer = app.listen(config.port, () => {
      console.error(
        `${SERVER_NAME} ${SERVER_VERSION} listening on :${config.port}/mcp ` +
          `(facilitator: ${config.facilitatorUrl})`,
      );
      resolve();
    });

    const shutdown = () => {
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.transport === 'stdio') {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
