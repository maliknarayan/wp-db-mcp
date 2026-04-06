import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";

// Connection from env vars
let DB_CONFIG = {
  host: process.env.WP_DB_HOST || "localhost",
  port: parseInt(process.env.WP_DB_PORT || "3306"),
  user: process.env.WP_DB_USER || "root",
  password: process.env.WP_DB_PASSWORD || "",
  database: process.env.WP_DB_NAME || "wordpress",
};

let TABLE_PREFIX = process.env.WP_TABLE_PREFIX || "wp_";

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({ ...DB_CONFIG, waitForConnections: true, connectionLimit: 5 });
  }
  return pool;
}

async function query(sql, params = []) {
  const conn = getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

const server = new McpServer({
  name: "wp-db",
  version: "1.0.0",
});

// --- Tool: Get product meta ---
server.tool(
  "get_product_meta",
  "Get all meta fields for a WooCommerce product by ID or SKU",
  {
    product_id: z.number().optional().describe("Product ID"),
    sku: z.string().optional().describe("Product SKU (used if product_id not provided)"),
    meta_key: z.string().optional().describe("Filter by specific meta key (optional)"),
  },
  async ({ product_id, sku, meta_key }) => {
    let pid = product_id;

    if (!pid && sku) {
      const rows = await query(
        `SELECT post_id FROM ${TABLE_PREFIX}postmeta WHERE meta_key = '_sku' AND meta_value = ? LIMIT 1`,
        [sku]
      );
      if (rows.length === 0) return { content: [{ type: "text", text: `No product found with SKU: ${sku}` }] };
      pid = rows[0].post_id;
    }

    if (!pid) return { content: [{ type: "text", text: "Provide either product_id or sku" }] };

    let sql = `SELECT meta_id, meta_key, meta_value FROM ${TABLE_PREFIX}postmeta WHERE post_id = ?`;
    const params = [pid];

    if (meta_key) {
      sql += ` AND meta_key = ?`;
      params.push(meta_key);
    }

    sql += ` ORDER BY meta_key`;
    const rows = await query(sql, params);

    // Get product title
    const [product] = await query(
      `SELECT post_title, post_status FROM ${TABLE_PREFIX}posts WHERE ID = ?`,
      [pid]
    );

    const header = product
      ? `Product: ${product.post_title} (ID: ${pid}, Status: ${product.post_status})\n${"─".repeat(60)}\n`
      : `Product ID: ${pid}\n${"─".repeat(60)}\n`;

    const text = header + rows.map((r) => `${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text: text || "No meta found" }] };
  }
);

// --- Tool: Search product meta ---
server.tool(
  "search_product_meta",
  "Search across all products for a specific meta key or meta value",
  {
    meta_key: z.string().optional().describe("Meta key to search for"),
    meta_value: z.string().optional().describe("Meta value to search for (supports % wildcards)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ meta_key, meta_value, limit }) => {
    const max = limit || 20;
    let sql = `
      SELECT p.ID, p.post_title, pm.meta_key, pm.meta_value
      FROM ${TABLE_PREFIX}postmeta pm
      JOIN ${TABLE_PREFIX}posts p ON p.ID = pm.post_id
      WHERE p.post_type IN ('product', 'product_variation')
    `;
    const params = [];

    if (meta_key) {
      sql += ` AND pm.meta_key LIKE ?`;
      params.push(meta_key);
    }
    if (meta_value) {
      sql += ` AND pm.meta_value LIKE ?`;
      params.push(meta_value);
    }

    sql += ` ORDER BY p.ID DESC LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows.map((r) => `[${r.ID}] ${r.post_title} → ${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text: text || "No results found" }] };
  }
);

// --- Tool: List products ---
server.tool(
  "list_products",
  "List WooCommerce products with optional filters",
  {
    status: z.string().optional().describe("Post status: publish, draft, trash (default: publish)"),
    category: z.string().optional().describe("Category slug to filter by"),
    search: z.string().optional().describe("Search term for product title"),
    limit: z.number().optional().describe("Max results (default 25)"),
  },
  async ({ status, category, search, limit }) => {
    const max = limit || 25;
    const postStatus = status || "publish";

    let sql = `
      SELECT p.ID, p.post_title, p.post_status,
        MAX(CASE WHEN pm.meta_key = '_price' THEN pm.meta_value END) as price,
        MAX(CASE WHEN pm.meta_key = '_sku' THEN pm.meta_value END) as sku,
        MAX(CASE WHEN pm.meta_key = '_stock_status' THEN pm.meta_value END) as stock_status
      FROM ${TABLE_PREFIX}posts p
      LEFT JOIN ${TABLE_PREFIX}postmeta pm ON p.ID = pm.post_id
    `;
    const params = [];

    if (category) {
      sql += `
        JOIN ${TABLE_PREFIX}term_relationships tr ON p.ID = tr.object_id
        JOIN ${TABLE_PREFIX}term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
        JOIN ${TABLE_PREFIX}terms t ON tt.term_id = t.term_id
      `;
    }

    sql += ` WHERE p.post_type = 'product' AND p.post_status = ?`;
    params.push(postStatus);

    if (category) {
      sql += ` AND tt.taxonomy = 'product_cat' AND t.slug = ?`;
      params.push(category);
    }

    if (search) {
      sql += ` AND p.post_title LIKE ?`;
      params.push(`%${search}%`);
    }

    sql += ` GROUP BY p.ID ORDER BY p.ID DESC LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows
      .map((r) => `[${r.ID}] ${r.post_title} | SKU: ${r.sku || "—"} | Price: ${r.price || "—"} | Stock: ${r.stock_status || "—"}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No products found" }] };
  }
);

// --- Tool: Get product variations ---
server.tool(
  "get_product_variations",
  "Get all variations of a variable product with their meta",
  {
    product_id: z.number().describe("Parent product ID"),
  },
  async ({ product_id }) => {
    const variations = await query(
      `SELECT p.ID, p.post_title, p.post_status FROM ${TABLE_PREFIX}posts p
       WHERE p.post_parent = ? AND p.post_type = 'product_variation'
       ORDER BY p.menu_order, p.ID`,
      [product_id]
    );

    if (variations.length === 0) {
      return { content: [{ type: "text", text: `No variations found for product ${product_id}` }] };
    }

    const results = [];
    for (const v of variations) {
      const meta = await query(
        `SELECT meta_key, meta_value FROM ${TABLE_PREFIX}postmeta
         WHERE post_id = ? AND meta_key LIKE 'attribute_%' OR (post_id = ? AND meta_key IN ('_price', '_regular_price', '_sale_price', '_sku', '_stock_status', '_stock'))
         ORDER BY meta_key`,
        [v.ID, v.ID]
      );
      const attrs = meta.map((m) => `  ${m.meta_key}: ${m.meta_value}`).join("\n");
      results.push(`Variation #${v.ID} (${v.post_status})\n${attrs}`);
    }

    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

// --- Tool: Run custom query (read-only) ---
server.tool(
  "wp_query",
  "Run a read-only SQL SELECT query against the WordPress database",
  {
    sql: z.string().describe("SQL SELECT query to execute (SELECT only, no modifications)"),
  },
  async ({ sql: rawSql }) => {
    const trimmed = rawSql.trim();
    if (!/^SELECT\s/i.test(trimmed)) {
      return { content: [{ type: "text", text: "Only SELECT queries are allowed" }] };
    }
    // Block dangerous keywords
    if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE)\b/i.test(trimmed)) {
      return { content: [{ type: "text", text: "Only read-only SELECT queries are allowed" }] };
    }

    const rows = await query(trimmed);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { content: [{ type: "text", text: "No results" }] };
    }

    const text = JSON.stringify(rows, null, 2);
    return { content: [{ type: "text", text }] };
  }
);

// --- Tool: Get WooCommerce taxonomy terms ---
server.tool(
  "get_product_terms",
  "Get taxonomy terms (categories, tags, attributes) for a product",
  {
    product_id: z.number().describe("Product ID"),
    taxonomy: z.string().optional().describe("Taxonomy: product_cat, product_tag, pa_* (default: all)"),
  },
  async ({ product_id, taxonomy }) => {
    let sql = `
      SELECT t.name, t.slug, tt.taxonomy, tt.count
      FROM ${TABLE_PREFIX}term_relationships tr
      JOIN ${TABLE_PREFIX}term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
      JOIN ${TABLE_PREFIX}terms t ON tt.term_id = t.term_id
      WHERE tr.object_id = ?
    `;
    const params = [product_id];

    if (taxonomy) {
      sql += ` AND tt.taxonomy = ?`;
      params.push(taxonomy);
    }

    sql += ` ORDER BY tt.taxonomy, t.name`;
    const rows = await query(sql, params);

    const text = rows.map((r) => `[${r.taxonomy}] ${r.name} (${r.slug}) — ${r.count} products`).join("\n");
    return { content: [{ type: "text", text: text || "No terms found" }] };
  }
);

// --- Tool: Get order meta ---
server.tool(
  "get_order_meta",
  "Get meta fields for a WooCommerce order",
  {
    order_id: z.number().describe("Order ID"),
    meta_key: z.string().optional().describe("Filter by specific meta key"),
  },
  async ({ order_id, meta_key }) => {
    let sql = `SELECT meta_key, meta_value FROM ${TABLE_PREFIX}postmeta WHERE post_id = ?`;
    const params = [order_id];

    if (meta_key) {
      sql += ` AND meta_key = ?`;
      params.push(meta_key);
    }
    sql += ` ORDER BY meta_key`;

    const rows = await query(sql, params);

    const [order] = await query(
      `SELECT post_title, post_status, post_date FROM ${TABLE_PREFIX}posts WHERE ID = ? AND post_type = 'shop_order'`,
      [order_id]
    );

    if (!order) return { content: [{ type: "text", text: `Order #${order_id} not found` }] };

    const header = `Order #${order_id} (${order.post_status}) — ${order.post_date}\n${"─".repeat(60)}\n`;
    const text = header + rows.map((r) => `${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// --- Tool: DB connection test ---
server.tool(
  "test_connection",
  "Test the WordPress database connection",
  {},
  async () => {
    try {
      const [row] = await query("SELECT 1 as ok");
      const [options] = await query(
        `SELECT option_value FROM ${TABLE_PREFIX}options WHERE option_name = 'siteurl' LIMIT 1`
      );
      const [count] = await query(
        `SELECT COUNT(*) as total FROM ${TABLE_PREFIX}posts WHERE post_type = 'product'`
      );
      return {
        content: [{
          type: "text",
          text: `Connected successfully!\nHost: ${DB_CONFIG.host}:${DB_CONFIG.port}\nDatabase: ${DB_CONFIG.database}\nSite URL: ${options?.option_value || "unknown"}\nTotal products: ${count?.total || 0}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Connection failed: ${err.message}` }] };
    }
  }
);

// --- Tool: Switch database ---
server.tool(
  "switch_database",
  "Switch to a different WordPress database without restarting. Use for multi-site support or switching between local/staging/production databases.",
  {
    database: z.string().describe("Database name (required)"),
    host: z.string().optional().describe("Database host (default: current)"),
    port: z.number().optional().describe("Database port (default: current)"),
    user: z.string().optional().describe("Database user (default: current)"),
    password: z.string().optional().describe("Database password (default: current)"),
    table_prefix: z.string().optional().describe("Table prefix (default: wp_)"),
  },
  async ({ database, host, port, user, password, table_prefix }) => {
    try {
      // Close existing pool
      if (pool) {
        await pool.end();
        pool = null;
      }

      // Update config
      DB_CONFIG = {
        host: host || DB_CONFIG.host,
        port: port || DB_CONFIG.port,
        user: user !== undefined ? user : DB_CONFIG.user,
        password: password !== undefined ? password : DB_CONFIG.password,
        database: database,
      };

      if (table_prefix !== undefined) {
        TABLE_PREFIX = table_prefix;
      }

      // Test new connection
      const conn = getPool();
      const [test] = await conn.execute("SELECT 1 as ok");

      const [options] = await query(
        `SELECT option_value FROM ${TABLE_PREFIX}options WHERE option_name = 'siteurl' LIMIT 1`
      );
      const [count] = await query(
        `SELECT COUNT(*) as total FROM ${TABLE_PREFIX}posts WHERE post_type = 'product'`
      );

      return {
        content: [{
          type: "text",
          text: `Switched successfully!\nHost: ${DB_CONFIG.host}:${DB_CONFIG.port}\nDatabase: ${DB_CONFIG.database}\nTable prefix: ${TABLE_PREFIX}\nSite URL: ${options?.option_value || "unknown"}\nTotal products: ${count?.total || 0}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Switch failed: ${err.message}` }] };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
