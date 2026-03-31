# parcel-mcp

Hosted MCP server for the [Parcel.app](https://parcelapp.net) delivery tracking API. This branch is set up for a remote Streamable HTTP deployment that works well behind Nginx for ChatGPT and other MCP clients.

## Tools

### `list_deliveries`
List deliveries from your Parcel account. Returns cached data from the Parcel servers.

- **Rate limit:** 20 requests/hour
- **Parameters:**
  - `filter_mode` (optional): `"active"` (in-progress only) or `"recent"` (default — active + recently completed)

### `add_delivery`
Add a new delivery to your Parcel account.

- **Rate limit:** 20 requests/day (includes failed requests)
- **Parameters:**
  - `tracking_number` (required): The package tracking number
  - `carrier_code` (required): Internal Parcel carrier code — see the [full carrier list](https://parcelapp.net/help/carriers.html). Use `"pholder"` for a placeholder.
  - `description` (required): A label for the delivery
  - `language` (optional): ISO 639-1 two-letter code, e.g. `"en"` (default), `"de"`
  - `send_push_confirmation` (optional): `true` to get a push notification when added (default `false`)

> **Note:** Newly added deliveries show "No data available" until the Parcel server first updates them.

## Requirements

- Node.js 18+ (Node 20 recommended)
- A Parcel premium account with an API key from [web.parcelapp.net](https://web.parcelapp.net)
- A Linux host where you can run Node behind Nginx

## Local Build

```bash
git clone https://github.com/as-j/parcellapp-mcp.git
cd parcellapp-mcp
npm install
npm run build
```

## Run The MCP Server

Create an env file from [deploy/env/parcel-mcp.env.example](/Users/asj/dev/parcellapp-mcp/deploy/env/parcel-mcp.env.example), then start the server:

```bash
export PARCEL_API_KEY=your_api_key_here
export HOST=127.0.0.1
export PORT=3001
npm run build
npm start
```

The server exposes:

- `GET /healthz` for health checks
- `POST /mcp` for initialize and JSON-RPC requests
- `GET /mcp` for SSE streaming
- `DELETE /mcp` for session shutdown

If you set `MCP_AUTH_TOKEN`, clients must send `Authorization: Bearer <token>`.

## Linode And Nginx

Generic deploy templates live in:

- [deploy/systemd/parcel-mcp.service](/Users/asj/dev/parcellapp-mcp/deploy/systemd/parcel-mcp.service)
- [deploy/nginx/parcel-mcp.conf.example](/Users/asj/dev/parcellapp-mcp/deploy/nginx/parcel-mcp.conf.example)
- [deploy/env/parcel-mcp.env.example](/Users/asj/dev/parcellapp-mcp/deploy/env/parcel-mcp.env.example)

Typical SSH deploy flow:

```bash
ssh your-server
cd /opt/parcel-mcp
git pull
npm ci
npm run build
sudo systemctl restart parcel-mcp
sudo systemctl status parcel-mcp
curl http://127.0.0.1:3001/healthz
```

Then point Nginx at the local Node process and use your public HTTPS MCP URL in ChatGPT.

## ChatGPT MCP Setup

Once Nginx is proxying to this service, use your HTTPS MCP endpoint URL ending in `/mcp` when adding the connector in ChatGPT. Keep the committed repo generic; your real hostname can stay only in your local Nginx config and server setup.

## Example Usage

Once configured, you can ask ChatGPT things like:

- *"What packages do I have in transit?"*
- *"Show me my active deliveries"*
- *"Add tracking number 1Z999AA10123456784 with carrier UPS, description 'New keyboard'"*
