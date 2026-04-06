# wp-db-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives **Claude Code** direct, read-only access to your WordPress / WooCommerce MySQL database.

## Features

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

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/maliknarayan/wp-db-mcp.git
cd wp-db-mcp
npm install
```

### 2. Add to Claude Code settings

Open your Claude Code MCP settings file and add the `wp-db` server:

**Option A: Project-level** (`.mcp.json` in your project root — recommended):

```json
{
  "mcpServers": {
    "wp-db": {
      "command": "node",
      "args": ["/full/path/to/wp-db-mcp/index.mjs"],
      "env": {
        "WP_DB_HOST": "localhost",
        "WP_DB_PORT": "3306",
        "WP_DB_USER": "root",
        "WP_DB_PASSWORD": "your_password",
        "WP_DB_NAME": "your_wordpress_db",
        "WP_TABLE_PREFIX": "wp_"
      }
    }
  }
}
```

**Option B: Global** (`~/.claude/settings.json` under `mcpServers`):

Same config as above, added under the `mcpServers` key in your global settings.

> **Important:** Replace `/full/path/to/wp-db-mcp/index.mjs` with the actual absolute path where you cloned the repo.

### 3. Restart Claude Code

The tools will be available immediately. Try asking Claude:

```
Test my WordPress database connection
```

## Configuration

All configuration is done via environment variables in your MCP settings (no `.env` file needed):

| Variable | Default | Description |
|---|---|---|
| `WP_DB_HOST` | `localhost` | MySQL host |
| `WP_DB_PORT` | `3306` | MySQL port |
| `WP_DB_USER` | `root` | MySQL username |
| `WP_DB_PASSWORD` | *(empty)* | MySQL password |
| `WP_DB_NAME` | `wordpress` | WordPress database name |
| `WP_TABLE_PREFIX` | `wp_` | WordPress table prefix |

## Usage Examples

Once configured, just ask Claude in natural language:

```
List all published products
```

```
Get meta for product with SKU "ABC-123"
```

```
Show me all variations of product #456
```

```
Search for products with meta key "_sale_price"
```

```
Run this query: SELECT ID, post_title FROM wp_posts WHERE post_type = 'product' LIMIT 10
```

## Switching Databases on the Fly

You can switch to a different WordPress database mid-conversation without restarting:

```
Switch to database "staging_wp" on host 127.0.0.1 port 3308
```

This is useful when working across multiple WordPress sites.

## Connecting to Remote / Staging via SSH Tunnel

```bash
# 1. Open an SSH tunnel to your staging server
ssh -L 3308:localhost:3306 user@staging-server.com

# 2. Then ask Claude to switch
Switch to database "staging_db" on host 127.0.0.1 port 3308
```

## Security

- **Read-only:** `wp_query` only allows `SELECT` statements — blocks DROP, DELETE, UPDATE, INSERT, ALTER, TRUNCATE, etc.
- **No hardcoded credentials:** DB credentials are passed via environment variables in your MCP config
- **Connection pooling:** Limited to 5 concurrent connections

## Requirements

- **Node.js** 18+
- **MySQL** or **MariaDB**
- **Claude Code** (CLI, Desktop, or IDE extension)

## License

ISC
