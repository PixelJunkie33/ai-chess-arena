// Durable state lives in one DynamoDB table (pk = "<kind>#<id>", data = JSON string).
// Without DYNAMO_TABLE everything stays in memory (local dev / tests).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || 'us-east-1';
let dynamo = null;
let table = null;

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

export function initPersistence() {
  table = process.env.DYNAMO_TABLE || null;
  if (table) dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  console.log(`[persistence] ${table ? `dynamodb:${table}` : 'memory only'}`);
}

export async function saveItem(kind, id, data) {
  if (!dynamo) return;
  try {
    await dynamo.send(new PutCommand({ TableName: table, Item: { pk: `${kind}#${id}`, kind, data: JSON.stringify(data) } }));
  } catch (err) { console.warn(`[dynamo] put ${kind}#${id}: ${err.message}`); }
}

export async function deleteItem(kind, id) {
  if (!dynamo) return;
  try { await dynamo.send(new DeleteCommand({ TableName: table, Key: { pk: `${kind}#${id}` } })); }
  catch (err) { console.warn(`[dynamo] delete ${kind}#${id}: ${err.message}`); }
}

/** Load every stored item as { kind, data }. */
export async function loadAll() {
  if (!dynamo) return [];
  const out = [];
  let key;
  do {
    const page = await dynamo.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    for (const it of page.Items ?? []) out.push({ kind: it.kind, data: JSON.parse(it.data) });
    key = page.LastEvaluatedKey;
  } while (key);
  return out;
}
