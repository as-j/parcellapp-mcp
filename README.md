# parcel-mcp

MCP server for the [Parcel.app](https://parcelapp.net) delivery tracking API. Lets Claude (and other MCP clients) list and add package deliveries in your Parcel account.

**[Download latest parcellapp-mcp.dxt](https://github.com/as-j/parcellapp-mcp/releases/latest/download/parcellapp-mcp.dxt)**

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

## Prerequisites

- Node.js 18+ (for built-in `fetch`)
- A Parcel premium account with an API key — generate one at [web.parcelapp.net](https://web.parcelapp.net)

## Setup

```bash
git clone https://github.com/as-j/parcellapp-mcp.git
cd parcellapp-mcp
npm install
npm run build
```

## Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "parcel": {
      "command": "node",
      "args": ["/absolute/path/to/parcellapp-mcp/dist/index.js"],
      "env": {
        "PARCEL_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Example Usage

Once configured, you can ask Claude things like:

- *"What packages do I have in transit?"*
- *"Show me my active deliveries"*
- *"Add tracking number 1Z999AA10123456784 with carrier UPS, description 'New keyboard'"*