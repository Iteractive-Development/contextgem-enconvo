import http from "node:http";
import crypto from "node:crypto";
import { UserSession, type LLMProvider } from "@enconvo/api";

/** Enconvo Cloud's System One gateway — the same endpoint the app's judge/classify workflow steps call. */
const SYSTEMONE_URL = "https://api.enconvo.com/typesafe/v1/systemone";
const COMMAND_KEY = "contextgem-enconvo|extract";
const COMMAND_TITLE = "ContextGem Extract";
const RETRYABLE = new Set([502, 503, 504]);

export interface Bridge {
    /** Base URL the Python runner points LiteLLM at. */
    url: string;
    /** Ephemeral bearer token; a secret for as long as the bridge runs. */
    token: string;
    close(): Promise<void>;
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr && typeof addr === "object") resolve({ server, port: addr.port });
            else server.close(() => reject(new Error("no port")));
        });
    });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
}

/** true when the request carries this bridge's token. */
function authorized(req: http.IncomingMessage, token: string): boolean {
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Chat bridge: OpenAI chat completions -> Enconvo's LLM providers
// ---------------------------------------------------------------------------

/** What a chat message looks like, however the provider packaged it. */
function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object") {
                    const p = part as { type?: string; text?: unknown };
                    if (typeof p.text === "string") return p.text;
                }
                return "";
            })
            .join("");
    }
    if (content && typeof content === "object") {
        const text = (content as { text?: unknown }).text;
        if (typeof text === "string") return text;
    }
    return "";
}

/**
 * A localhost OpenAI-compatible endpoint that answers from an Enconvo LLM provider.
 * ContextGem's runner points LiteLLM here, so every provider the app supports —
 * Enconvo Cloud points models, OAuth providers, local servers — runs extraction
 * with no API key ever leaving Enconvo's credential management.
 * Lives for one extraction job; close() in a finally.
 */
export async function startChatBridge(provider: LLMProvider): Promise<Bridge> {
    const token = crypto.randomBytes(24).toString("hex");
    const { server, port } = await listen(async (req, res) => {
        try {
            if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
                sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
                return;
            }
            if (!authorized(req, token)) {
                sendJson(res, 401, { error: { message: "bad bridge token", type: "invalid_request_error" } });
                return;
            }
            const body = JSON.parse((await readBody(req)) || "{}") as {
                messages?: Array<{ role?: string; content?: unknown }>;
                model?: string;
            };
            // Providers take OpenAI-style message objects (role + string content);
            // tuple form is rejected by their internals.
            const messages = (body.messages ?? []).map((m) => ({
                role: m.role ?? "user",
                content: textOf(m.content),
            }));
            const answer = await provider.call({ messages } as never);
            const message = answer as unknown as {
                content?: unknown;
                usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
                response_metadata?: {
                    model_name?: string;
                    token_usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
                };
            };
            const usageMeta = message.usage_metadata;
            const tokenUsage = message.response_metadata?.token_usage;
            const usage =
                usageMeta || tokenUsage
                    ? {
                          prompt_tokens: usageMeta?.input_tokens ?? tokenUsage?.prompt_tokens ?? 0,
                          completion_tokens: usageMeta?.output_tokens ?? tokenUsage?.completion_tokens ?? 0,
                          total_tokens: usageMeta?.total_tokens ?? tokenUsage?.total_tokens ?? 0,
                      }
                    : undefined;
            sendJson(res, 200, {
                id: `bridge-${crypto.randomUUID()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                // Echo the model the provider actually used when it says so, so usage
                // stats report the real model, not the label the runner sent.
                model: message.response_metadata?.model_name ?? body.model ?? "enconvo",
                choices: [
                    {
                        index: 0,
                        finish_reason: "stop",
                        message: { role: "assistant", content: textOf(message.content) },
                    },
                ],
                ...(usage ? { usage } : {}),
            });
        } catch (error) {
            sendJson(res, 500, {
                error: {
                    message: error instanceof Error ? error.message : String(error),
                    type: "server_error",
                },
            });
        }
    });
    return {
        url: `http://127.0.0.1:${port}/v1`,
        token,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
    };
}

// ---------------------------------------------------------------------------
// Decision bridge: LiteLLM's System One wire format -> Enconvo Cloud (Jev)
// ---------------------------------------------------------------------------

/**
 * A localhost System One endpoint (the wire format LiteLLM's Decisions API speaks
 * for typesafe/ models) that relays to Enconvo Cloud's Jev gateway with the
 * app's own session token. ContextGem's decision model points here as
 * typesafe/jev-latest, so closed questions get Jev's calibrated probabilities
 * and bill Enconvo Cloud points — no TypeSafe key to manage.
 */
export async function startDecisionBridge(upstream = SYSTEMONE_URL): Promise<Bridge> {
    const token = crypto.randomBytes(24).toString("hex");
    const { server, port } = await listen(async (req, res) => {
        try {
            if (req.method !== "POST" || !req.url?.startsWith("/v1/systemone")) {
                sendJson(res, 404, { error: { message: "not found" } });
                return;
            }
            if (!authorized(req, token)) {
                sendJson(res, 401, { error: { message: "bad bridge token" } });
                return;
            }
            const raw = await readBody(req);
            let body: Record<string, unknown>;
            try {
                body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            } catch {
                sendJson(res, 400, { error: { message: "body is not valid JSON" } });
                return;
            }
            if (!body.model) body.model = "jev-latest";

            const accessToken = await UserSession.getAccessToken();
            if (!accessToken) {
                sendJson(res, 401, { error: { message: "Sign in to Enconvo Cloud to use Jev decisions." } });
                return;
            }
            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                accessToken,
                client_id: String(process.env.client_id ?? ""),
                commandKey: COMMAND_KEY,
                commandTitle: COMMAND_TITLE,
            };
            const request = () =>
                fetch(upstream, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(60_000),
                });
            let upstreamRes = await request();
            if (RETRYABLE.has(upstreamRes.status)) {
                upstreamRes = await request(); // one retry, as the app's own judge steps do
            }
            const text = await upstreamRes.text();
            if (upstreamRes.status === 409) {
                sendJson(res, 409, { error: { message: "decision-bridge: not enough Enconvo Cloud points for this decision." } });
                return;
            }
            if ([401, 403, 444].includes(upstreamRes.status)) {
                sendJson(res, 401, { error: { message: "decision-bridge: Enconvo Cloud session is invalid; sign in again to use Jev." } });
                return;
            }
            res.writeHead(upstreamRes.status, { "content-type": "application/json" });
            res.end(text);
        } catch (error) {
            sendJson(res, 502, {
                error: {
                    message: `decision-bridge: Jev gateway unreachable: ${error instanceof Error ? error.message : String(error)}`,
                },
            });
        }
    });
    return {
        url: `http://127.0.0.1:${port}`,
        token,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
    };
}
