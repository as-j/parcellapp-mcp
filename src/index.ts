#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PARCEL_API_BASE = "https://api.parcel.app/external";
const VERSION = "1.0.0";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const HEALTH_PATH = process.env.HEALTH_PATH ?? "/healthz";
const MAX_BODY_SIZE = 1024 * 1024;

const STATUS_LABELS: Record<number, string> = {
  0: "Completed",
  1: "Frozen",
  2: "In Transit",
  3: "Expecting Pickup",
  4: "Out for Delivery",
  5: "Not Found",
  6: "Failed Attempt",
  7: "Exception",
  8: "Carrier Info Received",
};

type Delivery = {
  tracking_number: string;
  carrier_code: string;
  description: string;
  status_code: number;
  date_expected?: string;
  date_expected_end?: string;
  extra_information?: string;
  events: Array<{
    event: string;
    date: string;
    location?: string;
    additional?: string;
  }>;
};

type ParcelDeliveriesResponse = {
  success: boolean;
  error_message?: string;
  deliveries?: Delivery[];
};

type ParcelMutationResponse = {
  success: boolean;
  error_message?: string;
};

const transports: Record<string, StreamableHTTPServerTransport> = {};

function getApiKey(): string {
  const key = process.env.PARCEL_API_KEY;
  if (!key) {
    throw new Error("PARCEL_API_KEY environment variable is not set");
  }
  return key;
}

function getAuthToken(): string | undefined {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  return token ? token : undefined;
}

async function parcelFetch(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(`${PARCEL_API_BASE}${path}`, {
    ...options,
    headers: {
      "api-key": getApiKey(),
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const data = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error_message" in data
        ? String(data.error_message)
        : `Parcel API request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "parcel-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_deliveries",
        description:
          "List your Parcel.app deliveries. Returns cached data from the Parcel servers (rate limit: 20 req/hour).",
        inputSchema: {
          type: "object",
          properties: {
            filter_mode: {
              type: "string",
              enum: ["active", "recent"],
              description:
                '"active" returns only in-progress deliveries; "recent" (default) returns recently completed and active deliveries.',
            },
          },
        },
      },
      {
        name: "add_delivery",
        description:
          "Add a new delivery to Parcel.app. Tracking info will appear after the first server update. Rate limit: 20 req/day. carrier_code is required and must be specified explicitly. Use list_carriers to look it up if needed.",
        inputSchema: {
          type: "object",
          required: ["tracking_number", "carrier_code", "description"],
          properties: {
            tracking_number: {
              type: "string",
              description: "The package tracking number.",
            },
            carrier_code: {
              type: "string",
              description:
                'Internal Parcel carrier code. Use list_carriers to find the right code. Use "pholder" for a placeholder delivery.',
            },
            description: {
              type: "string",
              description: "A description for the delivery.",
            },
            language: {
              type: "string",
              description:
                'Two-letter ISO 639-1 language code for delivery info (for example "en" or "de"). Defaults to "en".',
            },
            send_push_confirmation: {
              type: "boolean",
              description: "Send a push notification once the delivery is added. Defaults to false.",
            },
          },
        },
      },
      {
        name: "list_carriers",
        description:
          "List all carriers supported by Parcel.app, optionally filtered by name or code. Use this to find the correct carrier_code before calling add_delivery.",
        inputSchema: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description:
                "Optional search string to filter carriers by name or code (case-insensitive).",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === "list_deliveries") {
      const filterMode = typeof args.filter_mode === "string" ? args.filter_mode : undefined;
      const query = filterMode ? `?filter_mode=${encodeURIComponent(filterMode)}` : "";
      const data = (await parcelFetch(`/deliveries/${query}`)) as ParcelDeliveriesResponse;

      if (!data.success) {
        return {
          content: [{ type: "text", text: `Error: ${data.error_message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      const deliveries = data.deliveries ?? [];
      if (deliveries.length === 0) {
        return { content: [{ type: "text", text: "No deliveries found." }] };
      }

      const lines = deliveries.map((delivery) => formatDelivery(delivery));
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }

    if (name === "add_delivery") {
      const body: Record<string, unknown> = {
        tracking_number: args.tracking_number,
        carrier_code: args.carrier_code,
        description: args.description,
      };

      if (args.language !== undefined) {
        body.language = args.language;
      }
      if (args.send_push_confirmation !== undefined) {
        body.send_push_confirmation = args.send_push_confirmation;
      }

      const data = (await parcelFetch("/add-delivery/", {
        method: "POST",
        body: JSON.stringify(body),
      })) as ParcelMutationResponse;

      if (!data.success) {
        return {
          content: [{ type: "text", text: `Error: ${data.error_message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Delivery "${String(args.description)}" (${String(args.tracking_number)}) added successfully. Tracking info will appear after the first server update.`,
          },
        ],
      };
    }

    if (name === "list_carriers") {
      const search = typeof args.search === "string" ? args.search : undefined;
      const response = await fetch(`${PARCEL_API_BASE}/supported_carriers.json`);
      const carriers = (await response.json()) as Record<string, string>;

      let entries = Object.entries(carriers);
      if (search) {
        const term = search.toLowerCase();
        entries = entries.filter(
          ([code, carrierName]) =>
            code.toLowerCase().includes(term) || carrierName.toLowerCase().includes(term)
        );
      }

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `No carriers found matching "${search}".` }],
        };
      }

      const lines = entries.map(([code, carrierName]) => `${code}: ${carrierName}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

function formatDelivery(delivery: Delivery): string {
  const status = STATUS_LABELS[delivery.status_code] ?? `Unknown (${delivery.status_code})`;
  const parts = [
    `**${delivery.description}**`,
    `  Tracking: ${delivery.tracking_number} (${delivery.carrier_code})`,
    `  Status: ${status}`,
  ];

  if (delivery.date_expected) {
    parts.push(
      `  Expected: ${delivery.date_expected}${delivery.date_expected_end ? ` - ${delivery.date_expected_end}` : ""}`
    );
  }
  if (delivery.extra_information) {
    parts.push(`  Extra: ${delivery.extra_information}`);
  }
  if (delivery.events.length > 0) {
    const latest = delivery.events[0];
    parts.push("  Latest event:");
    parts.push(
      `    ${latest.date}${latest.location ? ` - ${latest.location}` : ""}: ${latest.event}${latest.additional ? ` (${latest.additional})` : ""}`
    );
  }

  return parts.join("\n");
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expectedToken = getAuthToken();
  if (!expectedToken) {
    return true;
  }

  const authHeader = getHeaderValue(req.headers.authorization);
  return authHeader === `Bearer ${expectedToken}`;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(json));
  res.end(json);
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Bearer realm="parcel-mcp"');
  res.end("Unauthorized");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bufferChunk.length;
    if (total > MAX_BODY_SIZE) {
      throw new Error("Request body too large");
    }
    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
  const parsedBody = await readJsonBody(req);

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, parsedBody);
    return;
  }

  if (!isInitializeRequest(parsedBody)) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports[newSessionId] = transport;
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      delete transports[transport.sessionId];
    }
  };

  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function handleGetOrDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
  if (!sessionId || !transports[sessionId]) {
    sendText(res, 400, "Invalid or missing session ID");
    return;
  }

  await transports[sessionId].handleRequest(req, res);
}

async function main(): Promise<void> {
  if (!Number.isFinite(PORT) || PORT <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === HEALTH_PATH) {
        sendJson(res, 200, {
          ok: true,
          service: "parcel-mcp",
          version: VERSION,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        sendJson(res, 200, {
          service: "parcel-mcp",
          version: VERSION,
          transport: "streamable-http",
          mcp_path: MCP_PATH,
          health_path: HEALTH_PATH,
        });
        return;
      }

      if (url.pathname !== MCP_PATH) {
        sendText(res, 404, "Not found");
        return;
      }

      if (!isAuthorized(req)) {
        sendUnauthorized(res);
        return;
      }

      if (req.method === "POST") {
        await handlePost(req, res);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        await handleGetOrDelete(req, res);
        return;
      }

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
        res.end();
        return;
      }

      sendText(res, 405, "Method not allowed");
    } catch (error) {
      console.error("Request handling failed:", error);

      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`parcel-mcp listening on http://${HOST}:${PORT}${MCP_PATH}`);
  });

  const shutdown = async () => {
    for (const transport of Object.values(transports)) {
      await transport.close();
    }

    httpServer.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
