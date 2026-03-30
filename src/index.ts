#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PARCEL_API_BASE = "https://api.parcel.app/external";

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

function getApiKey(): string {
  const key = process.env.PARCEL_API_KEY;
  if (!key) throw new Error("PARCEL_API_KEY environment variable is not set");
  return key;
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
  return response.json();
}

const server = new Server(
  { name: "parcel-mcp", version: "1.0.0" },
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
        "Add a new delivery to Parcel.app. Tracking info will appear after the first server update. Rate limit: 20 req/day.",
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
              'Internal Parcel carrier code. Use "pholder" for a placeholder delivery. Full list at https://parcelapp.net/help/carriers.html',
          },
          description: {
            type: "string",
            description: "A description for the delivery.",
          },
          language: {
            type: "string",
            description:
              'Two-letter ISO 639-1 language code for delivery info (e.g. "en", "de"). Defaults to "en".',
          },
          send_push_confirmation: {
            type: "boolean",
            description:
              "Send a push notification once the delivery is added. Defaults to false.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_deliveries") {
    const filter_mode = (args as { filter_mode?: string }).filter_mode;
    const query = filter_mode ? `?filter_mode=${encodeURIComponent(filter_mode)}` : "";
    const data = (await parcelFetch(`/deliveries/${query}`)) as {
      success: boolean;
      error_message?: string;
      deliveries?: Array<{
        tracking_number: string;
        carrier_code: string;
        description: string;
        status_code: number;
        date_expected?: string;
        date_expected_end?: string;
        timestamp_expected?: number;
        timestamp_expected_end?: number;
        extra_information?: string;
        events: Array<{
          event: string;
          date: string;
          location?: string;
          additional?: string;
        }>;
      }>;
    };

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

    const lines = deliveries.map((d) => {
      const status = STATUS_LABELS[d.status_code] ?? `Unknown (${d.status_code})`;
      const parts = [
        `**${d.description}**`,
        `  Tracking: ${d.tracking_number} (${d.carrier_code})`,
        `  Status: ${status}`,
      ];
      if (d.date_expected) parts.push(`  Expected: ${d.date_expected}${d.date_expected_end ? ` – ${d.date_expected_end}` : ""}`);
      if (d.extra_information) parts.push(`  Extra: ${d.extra_information}`);
      if (d.events.length > 0) {
        parts.push("  Latest event:");
        const latest = d.events[0];
        parts.push(`    ${latest.date}${latest.location ? ` — ${latest.location}` : ""}: ${latest.event}${latest.additional ? ` (${latest.additional})` : ""}`);
      }
      return parts.join("\n");
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }

  if (name === "add_delivery") {
    const { tracking_number, carrier_code, description, language, send_push_confirmation } =
      args as {
        tracking_number: string;
        carrier_code: string;
        description: string;
        language?: string;
        send_push_confirmation?: boolean;
      };

    const body: Record<string, unknown> = { tracking_number, carrier_code, description };
    if (language !== undefined) body.language = language;
    if (send_push_confirmation !== undefined) body.send_push_confirmation = send_push_confirmation;

    const data = (await parcelFetch("/add-delivery/", {
      method: "POST",
      body: JSON.stringify(body),
    })) as { success: boolean; error_message?: string };

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
          text: `Delivery "${description}" (${tracking_number}) added successfully. Tracking info will appear after the first server update.`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
