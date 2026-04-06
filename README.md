# wp-db-mcp-server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude Code direct read-only access to your WordPress / WooCommerce database.

## What it does

Runs as a stdio child process inside Claude Code and exposes these tools:

| Tool | Purpose |
|---|---|
| `test_connection` | Verify DB connectivity, show site URL + product count |
| `switch_database` | Hot-swap to a different WP database without restart |
| `get_product_meta` | Get all meta for a product (by ID or SKU) |
| `search_product_meta` | Search meta across all products |
| `list_products` | List products with filters (status, category, search) |
| `get_product_variations` | Get variations of a variable product |
| `get_product_terms` | Get categories, tags, attributes for a product |
| `get_order_meta` | Get meta for a WooCommerce order |
| `wp_query` | Run arbitrary read-only SELECT queries |

## Security

- `wp_query` only allows `SELECT` statements — blocks DROP, DELETE, UPDATE, INSERT, ALTER, etc.
- DB credentials are passed via environment variables (never hardcoded)
- Connection pool limited to 5 concurrent connections

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your database credentials
```

### 3. Add to Claude Code

Add to your `~/.claude.json` (or `settings.json`):

```json
{
  "mcpServers": {
    "wp-db": {
      "command": "node",
      "args": ["--experimental-vm-modules", "/path/to/wp-db/index.mjs"],
      "env": {
        "WP_DB_HOST": "localhost",
        "WP_DB_PORT": "3306",
        "WP_DB_USER": "root",
        "WP_DB_PASSWORD": "",
        "WP_DB_NAME": "your_database",
        "WP_TABLE_PREFIX": "wp_"
      }
    }
  }
}
```

### 4. Restart Claude Code

The tools will be available immediately. Try asking Claude to `test_connection`.

## Switching databases on the fly

Use the `switch_database` tool to connect to a different WordPress database without restarting:

```
Switch to the staging database: host=127.0.0.1, port=3308, db=staging_wp
```

This is useful when working across multiple WordPress sites or connecting to staging via SSH tunnel.

## Remote / Staging via SSH Tunnel

```bash
# Open tunnel first
ssh -L 3308:localhost:3306 user@staging-server.com

# Then switch_database to 127.0.0.1:3308
```

## Requirements

- Node.js 18+
- MySQL / MariaDB
- Claude Code with MCP support

## License

ISC
