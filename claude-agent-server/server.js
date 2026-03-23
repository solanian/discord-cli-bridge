import { WebSocketServer, WebSocket } from 'ws';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const PORT = parseInt(process.env.PORT || '9877');
const wss = new WebSocketServer({ port: PORT });

// Track active sessions per client
const clientSessions = new Map();
let nextRequestId = 1;

console.log(`Claude Agent Server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (ws) => {
  const clientId = nextRequestId++;
  console.log(`Client ${clientId} connected`);

  // Per-client state: map of threadId -> sessionId
  const sessions = new Map();
  clientSessions.set(clientId, sessions);

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { id, method, params } = msg;

    try {
      switch (method) {
        case 'initialize': {
          ws.send(JSON.stringify({
            id,
            result: { name: 'claude-agent-server', version: '0.1.0' },
          }));
          break;
        }

        case 'session/start': {
          const { cwd, prompt, model, effort, sessionId: resumeId } = params || {};

          console.log(`[session/start] cwd=${cwd} resume=${resumeId || 'new'} prompt="${(prompt || '').slice(0, 60)}"`);

          const options = {
            maxTurns: 50,
            permissionMode: 'bypassPermissions',
            persistSession: true,
            cwd: cwd || '/workspace',
            ...(model && { model }),
            ...(effort && { effortLevel: effort }),
            ...(resumeId && { resume: resumeId }),
          };

          // Generate a thread ID for this session
          const threadId = resumeId || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Acknowledge start
          ws.send(JSON.stringify({ id, result: { threadId } }));

          // Run query and stream results
          try {
            let sessionId = null;

            for await (const event of query({
              prompt: prompt || '',
              options,
            })) {
              if (ws.readyState !== WebSocket.OPEN) break;

              switch (event.type) {
                case 'system': {
                  sessionId = event.session_id;
                  sessions.set(threadId, sessionId);
                  ws.send(JSON.stringify({
                    method: 'session/started',
                    params: { threadId, sessionId },
                  }));
                  break;
                }

                case 'assistant': {
                  const content = event.message?.content;
                  if (Array.isArray(content)) {
                    for (const part of content) {
                      if (part.type === 'text' && part.text) {
                        ws.send(JSON.stringify({
                          method: 'assistant/text',
                          params: { threadId, text: part.text },
                        }));
                      } else if (part.type === 'tool_use') {
                        ws.send(JSON.stringify({
                          method: 'assistant/tool_use',
                          params: { threadId, name: part.name, input: part.input },
                        }));
                      }
                    }
                  }
                  break;
                }

                case 'result': {
                  const finalSessionId = event.session_id || sessionId;
                  if (finalSessionId) sessions.set(threadId, finalSessionId);

                  if (event.is_error) {
                    ws.send(JSON.stringify({
                      method: 'session/error',
                      params: {
                        threadId,
                        sessionId: finalSessionId,
                        error: event.result || 'Unknown error',
                      },
                    }));
                  } else {
                    ws.send(JSON.stringify({
                      method: 'session/completed',
                      params: {
                        threadId,
                        sessionId: finalSessionId,
                        result: event.result,
                        durationMs: event.duration_ms,
                        cost: event.total_cost_usd,
                      },
                    }));
                  }
                  break;
                }
              }
            }
          } catch (err) {
            ws.send(JSON.stringify({
              method: 'session/error',
              params: { threadId, error: err.message },
            }));
          }
          break;
        }

        case 'session/resume': {
          // Resume uses the same session/start with resume ID
          const { threadId } = params || {};
          const sessionId = sessions.get(threadId);
          if (!sessionId) {
            ws.send(JSON.stringify({ id, error: { message: `No session found for thread ${threadId}` } }));
            break;
          }
          // Client should call session/start with sessionId to resume
          ws.send(JSON.stringify({ id, result: { sessionId } }));
          break;
        }

        case 'session/list': {
          try {
            const sessionList = await listSessions({
              cwd: params?.cwd || process.cwd(),
              limit: params?.limit || 20,
            });
            ws.send(JSON.stringify({ id, result: { sessions: sessionList } }));
          } catch (err) {
            ws.send(JSON.stringify({ id, error: { message: err.message } }));
          }
          break;
        }

        case 'session/messages': {
          try {
            const { sessionId } = params || {};
            const messages = await getSessionMessages(sessionId);
            ws.send(JSON.stringify({ id, result: { messages } }));
          } catch (err) {
            ws.send(JSON.stringify({ id, error: { message: err.message } }));
          }
          break;
        }

        default:
          ws.send(JSON.stringify({ id, error: { message: `Unknown method: ${method}` } }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ id, error: { message: err.message } }));
    }
  });

  ws.on('close', () => {
    console.log(`Client ${clientId} disconnected`);
    clientSessions.delete(clientId);
  });
});

// Health check endpoint via HTTP
import { createServer } from 'http';
const httpServer = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200);
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.listen(PORT + 1, () => {
  console.log(`Health check on http://0.0.0.0:${PORT + 1}/healthz`);
});
