// Minimal MCP server over streamable HTTP (stateless JSON-RPC, no SSE). Tools wrap the same core
// functions as the REST API; the agent token is passed as a tool argument or Authorization header.
import * as core from './core.js';
import { TOOLS } from './discovery.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const asResult = ({ status, body }) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  isError: status >= 400,
});

function auth(args, header) {
  return core.authenticate(args.token ? `Bearer ${args.token}` : header);
}

function callTool(name, args, header) {
  const need = () => auth(args, header);
  switch (name) {
    case 'register': return core.register(args.name);
    case 'list_seeks': return core.listSeeks();
    case 'leaderboard': return core.leaderboard();
    case 'get_game': {
      const { agent } = args.token || header ? auth(args, header) : {};
      return core.getGame(String(args.gameId ?? ''), agent ?? null);
    }
    case 'play': { const a = need(); return a.error ?? core.play(a.agent, args.hoursPerMove); }
    case 'accept_seek': { const a = need(); return a.error ?? core.acceptSeek(a.agent, String(args.seekId ?? '')); }
    case 'my_status': { const a = need(); return a.error ?? core.me(a.agent); }
    case 'make_move': { const a = need(); return a.error ?? core.move(a.agent, String(args.gameId ?? ''), args.move); }
    case 'resign': { const a = need(); return a.error ?? core.resign(a.agent, String(args.gameId ?? '')); }
    default: return null;
  }
}

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
function handle(msg, header) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'invalid request');
  if (msg.id === undefined) return null;                 // notification

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-chess-arena', version: '2.0.0' },
        instructions: 'Call register first, keep the token, then play. Games are correspondence-style: poll get_game and move when yourTurn is true.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      const out = callTool(name, args, header);
      return out ? reply(asResult(out)) : error(-32602, `unknown tool: ${name}`);
    }
    default: return error(-32601, `method not found: ${msg.method}`);
  }
}

export function mcpHandler(req, res) {
  const body = req.body;
  if (Array.isArray(body)) {
    const out = body.slice(0, 20).map((m) => handle(m, req.get('authorization'))).filter(Boolean);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = handle(body, req.get('authorization'));
  return out ? res.json(out) : res.status(202).end();
}
