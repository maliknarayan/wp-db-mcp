# wp-db-mcp

Chat with your WordPress / WooCommerce database in plain English through [Claude Code](https://claude.ai/claude-code).

No SQL needed. Just ask questions like:

- *"Show me all products that are out of stock"*
- *"How many products are in each category?"*
- *"Get details about the product with SKU ABC-123"*
- *"List recent orders from last week"*
- *"What was the total revenue this month?"*
- *"Find all customers with gmail addresses"*
- *"Does product #456 have the `_sale_price` meta?"*

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects Claude Code directly to your MySQL database — read-only and safe.

## Tools

### Connection & Site Info
| Tool | What you can ask |
|---|---|
| `test_connection` | *"Test my database connection"* |
| `switch_database` | *"Switch to the staging database"* |
| `get_site_info` | *"What's the site name and currency?"* |

### Products
| Tool | What you can ask |
|---|---|
| `list_products` | *"Show all draft products"*, *"Find products with 'laptop' in the name"* |
| `get_product` | *"Tell me everything about product #123"*, *"Get product with SKU ABC"* |
| `get_product_meta` | *"Does product #456 have \_sale\_price meta?"*, *"Show all meta for this SKU"* |
| `search_product_meta` | *"How many products have \_sale\_price?"*, *"Find all products with meta key X"* |
| `get_product_variations` | *"Show variations of product #789"* |
| `get_product_terms` | *"What categories is product #123 in?"* |
| `count_products` | *"How many products per category?"*, *"Count products by stock status"* |
| `stock_overview` | *"Which products are out of stock?"*, *"Show low stock products"* |

### Orders & Sales
| Tool | What you can ask |
|---|---|
| `list_orders` | *"Show recent orders"*, *"Orders with status processing"* |
| `get_order` | *"Full details of order #1001"* |
| `get_order_meta` | *"Raw meta for order #1001"* |
| `sales_summary` | *"Revenue this month"*, *"Sales summary for last week"* |

### Customers
| Tool | What you can ask |
|---|---|
| `list_customers` | *"Show all customers"*, *"Find user by email"* |
| `get_customer` | *"Details about customer john@example.com"*, *"Customer #42 order history"* |

### Categories & Attributes
| Tool | What you can ask |
|---|---|
| `list_categories` | *"What product categories exist?"* |
| `list_attributes` | *"What product attributes are set up?"*, *"Show all color options"* |

### Fallback
| Tool | What you can ask |
|---|---|
| `wp_query` | *"Run this SQL: SELECT ..."* (read-only SELECT only) |

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/maliknarayan/wp-db-mcp.git
cd wp-db-mcp
npm install
```

### 2. Add to Claude Code

Add to your MCP settings. You have two options:

**Option A — Project-level** (`.mcp.json` in your project root):

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

**Option B — Global** (`~/.claude/settings.json`):

Add the same config under the `mcpServers` key.

> **Important:** Replace `/full/path/to/wp-db-mcp/index.mjs` with the absolute path where you cloned the repo.

### 3. Restart Claude Code

Start chatting with your database:

```
Test my WordPress database connection
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WP_DB_HOST` | `localhost` | MySQL host |
| `WP_DB_PORT` | `3306` | MySQL port |
| `WP_DB_USER` | `root` | MySQL username |
| `WP_DB_PASSWORD` | *(empty)* | MySQL password |
| `WP_DB_NAME` | `wordpress` | WordPress database name |
| `WP_TABLE_PREFIX` | `wp_` | WordPress table prefix |

## Switching Databases on the Fly

Switch to a different WordPress database mid-conversation:

```
Switch to database "staging_wp" on host 127.0.0.1 port 3308
```

## Remote / Staging via SSH Tunnel

```bash
# 1. Open tunnel
ssh -L 3308:localhost:3306 user@staging-server.com

# 2. Ask Claude to switch
Switch to database "staging_db" on host 127.0.0.1 port 3308
```

## Security

- **Read-only** — only SELECT queries allowed, all write operations blocked
- **No hardcoded credentials** — everything via environment variables
- **Connection pooling** — max 5 concurrent connections

## Requirements

- Node.js 18+
- MySQL / MariaDB
- Claude Code (CLI, Desktop, or IDE extension)

## License

ISC
