// Redis holds live game state; DynamoDB holds finished-match history.
// Both adapters degrade to in-memory when not configured or unreachable, so
// local dev works with nothing but `npm start`.
import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.DYNAMO_TABLE || 'ai-chess-arena-matches';

/** Merge JSON key/values from AWS Secrets Manager (SECRETS_ID) into process.env. */
export async function loadSecrets() {
  const id = process.env.SECRETS_ID;
  if (!id) return;
  try {
    const sm = new SecretsManagerClient({ region: REGION });
    const out = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    const values = JSON.parse(out.SecretString || '{}');
    for (const [k, v] of Object.entries(values)) if (!(k in process.env)) process.env[k] = String(v);
    console.log(`[secrets] loaded ${Object.keys(values).length} value(s) from Secrets Manager`);
  } catch (err) {
    console.warn(`[secrets] could not load ${id}: ${err.message}`);
  }
}

const memLive = new Map();
const memHistory = [];
let redis = null;
let dynamo = null;
let dynamoOk = true;

export function initPersistence() {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: (n) => (n > 5 ? null : Math.min(n * 500, 3000)),
    });
    redis.on('error', (e) => console.warn(`[redis] ${e.message}`));
    redis.connect().catch(() => { redis = null; });
  }
  if (process.env.DYNAMO_TABLE) {
    dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }
  console.log(`[persistence] live=${process.env.REDIS_URL ? 'redis' : 'memory'} history=${dynamo ? 'dynamodb' : 'memory'}`);
}

export async function saveLiveState(roomId, snapshot) {
  memLive.set(roomId, snapshot);
  if (!redis) return;
  try { await redis.set(`room:${roomId}`, JSON.stringify(snapshot), 'EX', 3600); } catch { /* memory copy stands */ }
}

export async function loadLiveState(roomId) {
  if (redis) {
    try {
      const raw = await redis.get(`room:${roomId}`);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through */ }
  }
  return memLive.get(roomId) ?? null;
}

export async function deleteLiveState(roomId) {
  memLive.delete(roomId);
  if (redis) { try { await redis.del(`room:${roomId}`); } catch { /* ignore */ } }
}

export async function recordMatch(match) {
  memHistory.push(match);
  if (memHistory.length > 5000) memHistory.shift();
  if (!dynamo || !dynamoOk) return;
  try {
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: match }));
  } catch (err) {
    console.warn(`[dynamo] write failed: ${err.message}`);
    if (err.name === 'ResourceNotFoundException') dynamoOk = false;
  }
}

/** All-time results: { total, white, black, draw, byAgent: { name: { wins, losses, draws } } } */
export async function getStats() {
  let items = memHistory;
  if (dynamo && dynamoOk) {
    try {
      items = [];
      let key;
      do {
        const out = await dynamo.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: key }));
        items.push(...(out.Items ?? []));
        key = out.LastEvaluatedKey;
      } while (key);
    } catch (err) {
      console.warn(`[dynamo] scan failed: ${err.message}`);
      items = memHistory;
    }
  }
  const stats = { total: items.length, white: 0, black: 0, draw: 0, byAgent: {} };
  const agent = (n) => (stats.byAgent[n] ??= { wins: 0, losses: 0, draws: 0 });
  for (const m of items) {
    stats[m.winner] = (stats[m.winner] ?? 0) + 1;
    const w = agent(m.agentWhite), b = agent(m.agentBlack);
    if (m.winner === 'white') { w.wins++; b.losses++; }
    else if (m.winner === 'black') { b.wins++; w.losses++; }
    else { w.draws++; b.draws++; }
  }
  return stats;
}
