// Minimal MCP mock server implementing a Streamable-HTTP JSON-RPC interface
// No external dependencies so it can run in node:20-slim without npm install.

const http = require('http');

const PORT = process.env.PORT || 4000;

// A tiny in-memory set of tools
const tools = [
  {
    name: 'echo',
    description: 'Echoes the provided input back as result',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' }
      },
      required: ['message']
    }
  },
];

function makeJsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', result, id });
}

function makeJsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

function sendResult(res, id, resultObj) {
  const body = makeJsonRpcResult(id, resultObj);
  try {
    console.log('MCP mock response:', body);
    const fs = require('fs');
    fs.appendFileSync('/tmp/mcp-mock-responses.log', body + '\n');
  } catch (e) {
    // ignore logging errors
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendError(res, id, code, message, statusCode = 400) {
  const body = makeJsonRpcError(id, code, message);
  try {
    console.log('MCP mock error response:', body);
    const fs = require('fs');
    fs.appendFileSync('/tmp/mcp-mock-responses.log', body + '\n');
  } catch (e) {
    // ignore logging errors
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Minimal SSE endpoint for LibreChat compatibility
  if (req.method === 'GET' && req.url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: message\ndata: {\"status\":\"ok\"}\n\n`);
    // Keep the connection open
    const interval = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, 15000);
    req.on('close', () => {
      clearInterval(interval);
    });
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  // Read body
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    // Protect against very large bodies
    if (body.length > 1e6) req.socket.destroy();
  });

  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(makeJsonRpcError(null, -32700, 'Parse error')); // invalid JSON
      return;
    }
    const method = parsed.method;
    const id = parsed.id ?? null;

    // Log the incoming JSON-RPC payload to help debugging client behaviour
    try {
      console.log('Incoming JSON-RPC request:', JSON.stringify(parsed));
    } catch (e) {
      console.log('Incoming JSON-RPC request (unserializable)');
    }

    // Log incoming JSON-RPC requests so we can see what the MCP client asks for.
    const logLine = JSON.stringify({ method, id, params: parsed.params });
    console.log('MCP mock received request:', logLine);
    // Also write to a temporary file inside the container for easier inspection
    // (the app directory is mounted read-only, so use /tmp).
    try {
      const fs = require('fs');
      fs.appendFileSync('/tmp/mcp-mock-requests.log', logLine + '\n');
    } catch (e) {
      // ignore
    }

    // Implement minimal JSON-RPC methods used by MCP client
    // listTools -> { tools: [...] }
    if (method === 'listTools' || method === 'tools/list') {
      const result = { tools };
      sendResult(res, id, result);
      return;
    }

    // listResources
    if (method === 'listResources' || method === 'resources/list') {
      const result = { resources: [] };
      sendResult(res, id, result);
      return;
    }

    // listPrompts
    if (method === 'listPrompts' || method === 'prompts/list') {
      const result = { prompts: [] };
      sendResult(res, id, result);
      return;
    }

    // call tool (method: 'tools/call') params: { name, arguments }
    if (method === 'tools/call' || method === 'callTool') {
      const params = parsed.params || {};
      const name = params.name || params.tool?.name || null;
      const args = params.arguments || params.tool?.arguments || {};

      if (!name) {
        sendError(res, id, -32602, 'Missing tool name', 400);
        return;
      }

      if (name === 'echo') {
        const message = args.message || '';
  const result = { type: 'tool_result', value: { output: message } };
  sendResult(res, id, result);
  return;
      }

      // Unknown tool
      sendError(res, id, -32000, `Tool not found: ${name}`, 404);
      return;
    }

    // ping
    if (method === 'ping') {
      sendResult(res, id, {});
      return;
    }

    // Some MCP clients send initialization or handshake methods before listing tools.
    // Return a minimal but valid initialize response so clients that validate the
    // handshake (like LibreChat) receive the expected fields.
    if (method === 'initialize' || method === 'init' || method === 'handshake') {
      const result = {
        protocolVersion: '2025-11-25',
        // advertise minimal capabilities the mock supports
        capabilities: {
          supportsToolCalls: true,
          supportsStreams: false,
        },
        serverInfo: {
          name: 'librechat-mcp-mock',
          version: '0.1.0',
        },
      };
      sendResult(res, id, result);
      return;
    }

    // Some clients may send lightweight queries like serverInfo/getMetadata/status/ping
    // which we can satisfy with an empty success to keep behaviour permissive.
    const acceptedNoopMethods = new Set([
      'serverInfo',
      'getMetadata',
      'status',
      'ping',
    ]);

    if (acceptedNoopMethods.has(method)) {
      sendResult(res, id, {});
      return;
    }

    // default: method not found
    sendError(res, id, -32601, 'Method not found', 404);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP mock server listening on 0.0.0.0:${PORT}`);
});

// graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
