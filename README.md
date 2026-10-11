# AI Chess Arena

AI agents play chess against each other while spectators watch live over WebSocket.
Served over plain HTTP on the EC2 public IP, port 3000. No domain, no TLS, no CDN.

## Architecture

```
browser ──ws──▶ Express + Socket.io (server/index.js)
                  │  GameManager: rooms + state machine (idle → running ⇄ paused → over)
                  │  aiRunner ─▶ worker thread ─▶ ChessEngine (client/js/ChessEngine.js, shared)
                  ├─ Redis     live game state   (optional; in-memory fallback)
                  └─ DynamoDB  finished matches  (optional; in-memory fallback)
```

- `client/js/ChessEngine.js` is the single engine implementation. chess.js generates legal moves;
  search (iterative-deepening alpha-beta, null-move pruning, MVV-LVA / check / killer / history ordering,
  2 s hard cutoff), piece-square tables and personality moods are custom. The server imports it and
  runs it in a worker thread so a 2 s search never blocks sockets.
- The server is authoritative: clients only render. The main room (`main`) starts a match
  as soon as the first spectator joins; any spectator can restart it after the 8 s game-over countdown.
- Spectator connections are rate-limited to 30/s per IP (`express-rate-limit` on the engine handshake).

### API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | `{ "status": "ok" }` |
| POST | `/api/match/new` | `{ "roomId" }` |
| GET | `/api/match/:id` | state snapshot |
| GET | `/api/stats` | all-time results |

Socket.io: server → client `gameState`, `move`, `gameOver`, `thinking`, `spectators`;
client → server `joinRoom`, `startMatch`, `pauseMatch`, `resetMatch`, `setSpeed` (the last and `spectators` are small additions to the spec).

## Local development

```bash
npm install
npm test            # engine, commentary, REST + socket tests
npm start           # http://localhost:3000
# or, with a Redis sidecar:
docker compose up --build
```

Environment variables (all optional): `PORT`, `REDIS_URL`, `DYNAMO_TABLE`, `AWS_REGION`, `SECRETS_ID`.
If `SECRETS_ID` is set, its JSON key/values are read from AWS Secrets Manager at start-up and merged into
the environment. No secrets live in the repository.

## AWS deployment (us-east-1)

1. Create the DynamoDB table: `aws dynamodb create-table --table-name ai-chess-arena-matches --attribute-definitions AttributeName=matchId,AttributeType=S --key-schema AttributeName=matchId,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-east-1`
2. Create an EC2 role from `infra/iam-policy.json` and an instance profile.
3. Launch a `t3.small` (Amazon Linux 2023, default VPC) with that profile, `infra/ec2-userdata.sh` as user data,
   and a security group allowing inbound 22, 80, 443 and 3000.
4. The app is live at `http://<EC2-PUBLIC-IP>:3000`.

### CI/CD

`.github/workflows/deploy.yml`: test → build image → push to ECR → CodeDeploy.
Required GitHub secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ECR_REGISTRY`
(use a dedicated least-privilege IAM user, never root keys).
CodeDeploy reads `appspec.yml` from the repository root (a copy of `infra/appspec.yml`); its hooks stop the
old container, build and start the new one next to a Redis container, then poll `/api/health`.

## Backlog

Human vs AI (P1), mobile layout polish (P1), Syzygy tablebases (P2), custom domain/SSL (P2), spectator chat (P2), ELO (P3), opening book (P3).
