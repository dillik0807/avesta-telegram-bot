/**
 * SQLite версия базы данных
 * Используется при локальном запуске без DATABASE_URL
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'orders.db');

// Промисифицированная обёртка над sqlite3
class SqliteDb {
  constructor(filePath) {
    this.db = new sqlite3.Database(filePath);
    console.log('✅ SQLite подключен:', filePath);
    this._ready = this.init();
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async init() {
    try {
      await this.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        name TEXT,
        phone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS registration_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        username TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        added_by INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        warehouse TEXT,
        transport_number TEXT,
        comment TEXT,
        status TEXT DEFAULT 'new',
        is_deleted INTEGER DEFAULT 0,
        deleted_at DATETIME,
        deleted_by TEXT,
        restored_at DATETIME,
        restored_by TEXT,
        client_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        quantity TEXT NOT NULL
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS warehouses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        whatsapp_group_id TEXT,
        whatsapp_phone TEXT,
        green_api_instance_id TEXT,
        green_api_token TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS cash_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        client_name TEXT,
        client_phone TEXT,
        mode TEXT NOT NULL,
        usd REAL DEFAULT 0,
        somoni REAL DEFAULT 0,
        rate REAL DEFAULT 0,
        admin_id INTEGER,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await this.run(`CREATE TABLE IF NOT EXISTS cash_report_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Миграции: добавить колонки если их нет
      const migrations = [
        `ALTER TABLE warehouses ADD COLUMN whatsapp_group_id TEXT`,
        `ALTER TABLE warehouses ADD COLUMN whatsapp_phone TEXT`,
        `ALTER TABLE warehouses ADD COLUMN green_api_instance_id TEXT`,
        `ALTER TABLE warehouses ADD COLUMN green_api_token TEXT`,
        `ALTER TABLE warehouses ADD COLUMN is_active INTEGER DEFAULT 1`,
        `ALTER TABLE products ADD COLUMN is_active INTEGER DEFAULT 1`,
        `ALTER TABLE clients ADD COLUMN is_active INTEGER DEFAULT 1`,
        `ALTER TABLE clients ADD COLUMN cash_access INTEGER DEFAULT 0`,
        `ALTER TABLE cash_records ADD COLUMN comment TEXT`,
        `ALTER TABLE orders ADD COLUMN client_id INTEGER`,
      ];
      for (const sql of migrations) {
        await this.run(sql).catch(() => {}); // игнорируем ошибку "column already exists"
      }

      console.log('✅ Таблицы SQLite инициализированы');
    } catch (error) {
      console.error('❌ Ошибка инициализации SQLite:', error.message);
    }
  }
}

const db = new SqliteDb(dbPath);

class Database {
  constructor() {}

  async _ready() {
    return db._ready;
  }

  async getOrCreateUser(telegramId, name, phone) {
    await db._ready;
    let user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (!user) {
      const result = await db.run(
        'INSERT INTO users (telegram_id, name, phone) VALUES (?, ?, ?)',
        [telegramId, name, phone]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
    }
    return user;
  }

  async createOrder(userId, warehouse, transportNumber, comment) {
    await db._ready;
    const result = await db.run(
      'INSERT INTO orders (user_id, warehouse, transport_number, comment) VALUES (?, ?, ?, ?)',
      [userId, warehouse, transportNumber, comment]
    );
    return result.lastID;
  }

  async addOrderItem(orderId, productName, quantity) {
    await db._ready;
    await db.run(
      'INSERT INTO order_items (order_id, product_name, quantity) VALUES (?, ?, ?)',
      [orderId, productName, quantity]
    );
  }

  async addClient(telegramId, name, phone, addedBy) {
    await db._ready;
    try {
      await db.run(
        'INSERT INTO clients (telegram_id, name, phone, added_by) VALUES (?, ?, ?, ?)',
        [telegramId, name || '', phone || '', addedBy]
      );
      await this.getOrCreateUser(telegramId, name, phone);
      return true;
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  async isClient(telegramId) {
    await db._ready;
    const row = await db.get(
      'SELECT id FROM clients WHERE telegram_id = ? AND is_active = 1',
      [telegramId]
    );
    return !!row;
  }

  async getAllClients() {
    await db._ready;
    return db.all(
      'SELECT * FROM clients WHERE is_active = 1 ORDER BY name'
    );
  }

  async removeClient(telegramId) {
    await db._ready;
    const result = await db.run(
      'UPDATE clients SET is_active = 0 WHERE telegram_id = ?',
      [telegramId]
    );
    return result.changes > 0;
  }

  // ── Доступ к кассе для клиентов ──────────────────────────────────────────────
  async hasCashAccess(telegramId) {
    await db._ready;
    try {
      const row = await db.get('SELECT cash_access FROM clients WHERE telegram_id = ? AND is_active = 1', [telegramId]);
      return row && row.cash_access === 1;
    } catch (e) {
      return false;
    }
  }

  async grantCashAccess(telegramId) {
    await db._ready;
    const result = await db.run('UPDATE clients SET cash_access = 1 WHERE telegram_id = ? AND is_active = 1', [telegramId]);
    return result.changes > 0;
  }

  async revokeCashAccess(telegramId) {
    await db._ready;
    const result = await db.run('UPDATE clients SET cash_access = 0 WHERE telegram_id = ?', [telegramId]);
    return result.changes > 0;
  }

  async getClientsWithCashAccess() {
    await db._ready;
    return db.all('SELECT telegram_id, name, phone FROM clients WHERE is_active = 1 AND cash_access = 1 ORDER BY name');
  }

  async getClient(telegramId) {
    await db._ready;
    return db.get('SELECT * FROM clients WHERE telegram_id = ?', [telegramId]);
  }

  async updateClient(telegramId, name, phone) {
    await db._ready;
    await db.run(
      'UPDATE clients SET name = ?, phone = ? WHERE telegram_id = ?',
      [name, phone, telegramId]
    );
    await db.run(
      'UPDATE users SET name = ?, phone = ? WHERE telegram_id = ?',
      [name, phone, telegramId]
    );
    return true;
  }

  async createRegistrationRequest(telegramId, name, username) {
    await db._ready;
    try {
      await db.run(
        'INSERT INTO registration_requests (telegram_id, name, username) VALUES (?, ?, ?)',
        [telegramId, name, username || '']
      );
      return true;
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  async getRegistrationRequest(telegramId) {
    await db._ready;
    return db.get('SELECT * FROM registration_requests WHERE telegram_id = ?', [telegramId]);
  }

  async getPendingRequests() {
    await db._ready;
    return db.all("SELECT * FROM registration_requests WHERE status = 'pending' ORDER BY created_at DESC");
  }

  async getPendingRequest(telegramId) {
    await db._ready;
    return db.get(
      "SELECT * FROM registration_requests WHERE telegram_id = ? AND status = 'pending'",
      [telegramId]
    );
  }

  async approveClient(telegramId, name, phone, approvedBy) {
    await db._ready;
    await db.run(
      "UPDATE registration_requests SET status = 'approved' WHERE telegram_id = ?",
      [telegramId]
    );
    return this.addClient(telegramId, name, phone, approvedBy);
  }

  async rejectRequest(telegramId) {
    await db._ready;
    await db.run(
      "UPDATE registration_requests SET status = 'rejected' WHERE telegram_id = ?",
      [telegramId]
    );
    return true;
  }

  async addWarehouse(name, whatsappGroupId = null) {
    await db._ready;
    const result = await db.run(
      'INSERT OR IGNORE INTO warehouses (name, whatsapp_group_id) VALUES (?, ?)',
      [name, whatsappGroupId]
    );
    return result.lastID;
  }

  async updateWarehouseWhatsApp(warehouseName, whatsappGroupId) {
    await db._ready;
    const result = await db.run(
      'UPDATE warehouses SET whatsapp_group_id = ? WHERE name = ?',
      [whatsappGroupId, warehouseName]
    );
    return result.changes > 0;
  }

  async getWarehouseWhatsApp(warehouseName) {
    await db._ready;
    const row = await db.get('SELECT whatsapp_group_id FROM warehouses WHERE name = ?', [warehouseName]);
    return row ? row.whatsapp_group_id : null;
  }

  async updateWarehouseWhatsAppPhone(warehouseName, whatsappPhone) {
    await db._ready;
    const result = await db.run(
      'UPDATE warehouses SET whatsapp_phone = ? WHERE name = ?',
      [whatsappPhone, warehouseName]
    );
    return result.changes > 0;
  }

  async getWarehouseWhatsAppPhone(warehouseName) {
    await db._ready;
    const row = await db.get('SELECT whatsapp_phone FROM warehouses WHERE name = ?', [warehouseName]);
    return row ? row.whatsapp_phone : null;
  }

  async getWarehouseWhatsAppSettings(warehouseName) {
    await db._ready;
    return db.get(
      'SELECT whatsapp_group_id, whatsapp_phone, green_api_instance_id, green_api_token FROM warehouses WHERE name = ?',
      [warehouseName]
    );
  }

  async updateWarehouseGreenApi(warehouseName, instanceId, token) {
    await db._ready;
    const result = await db.run(
      'UPDATE warehouses SET green_api_instance_id = ?, green_api_token = ? WHERE name = ?',
      [instanceId, token, warehouseName]
    );
    return result.changes > 0;
  }

  async getAllWarehouses() {
    await db._ready;
    return db.all(
      'SELECT * FROM warehouses WHERE is_active = 1 OR is_active IS NULL ORDER BY name'
    );
  }

  async removeWarehouse(id) {
    await db._ready;
    const result = await db.run('UPDATE warehouses SET is_active = 0 WHERE id = ?', [id]);
    return result.changes > 0;
  }

  async addProduct(name) {
    await db._ready;
    const result = await db.run('INSERT OR IGNORE INTO products (name) VALUES (?)', [name]);
    return result.lastID;
  }

  async getAllProducts() {
    await db._ready;
    return db.all(
      'SELECT * FROM products WHERE is_active = 1 OR is_active IS NULL ORDER BY name'
    );
  }

  async removeProduct(id) {
    await db._ready;
    const result = await db.run('UPDATE products SET is_active = 0 WHERE id = ?', [id]);
    return result.changes > 0;
  }

  async softDeleteOrder(orderId, deletedBy = 'admin') {
    await db._ready;
    const result = await db.run(
      'UPDATE orders SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?',
      [deletedBy, orderId]
    );
    return result.changes > 0;
  }

  async restoreOrder(orderId, restoredBy = 'admin') {
    await db._ready;
    const result = await db.run(
      'UPDATE orders SET is_deleted = 0, restored_at = CURRENT_TIMESTAMP, restored_by = ? WHERE id = ?',
      [restoredBy, orderId]
    );
    return result.changes > 0;
  }

  async getDeletedOrders() {
    await db._ready;
    return db.all('SELECT * FROM orders WHERE is_deleted = 1 ORDER BY deleted_at DESC');
  }

  async getClientOrders(clientTelegramId, limit = 5) {
    await db._ready;
    const user = await db.get('SELECT id FROM users WHERE telegram_id = ?', [clientTelegramId]);
    if (!user) return [];
    return db.all(
      'SELECT * FROM orders WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?',
      [user.id, limit]
    );
  }

  async addCashRecord(clientId, clientName, clientPhone, mode, usd, somoni, rate, adminId, comment) {
    await db._ready;
    const result = await db.run(
      'INSERT INTO cash_records (client_id, client_name, client_phone, mode, usd, somoni, rate, admin_id, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [clientId, clientName, clientPhone, mode, usd || 0, somoni || 0, rate || 0, adminId, comment || '']
    );
    return result.lastID;
  }

  async getLastCashReportSent() {
    await db._ready;
    const row = await db.get('SELECT sent_at FROM cash_report_sent ORDER BY sent_at DESC LIMIT 1');
    return row ? row.sent_at : null;
  }

  async markCashReportSent() {
    await db._ready;
    await db.run('INSERT INTO cash_report_sent DEFAULT VALUES');
  }

  async getCashReport(days) {
    await db._ready;
    const lastSent = await this.getLastCashReportSent();
    let sql = 'SELECT * FROM cash_records';
    const params = [];
    if (lastSent) {
      sql += ' WHERE created_at > ?';
      params.push(lastSent);
    }
    sql += ' ORDER BY created_at DESC';
    return db.all(sql, params);
  }

  async getCashTotals(days = 7) {
    await db._ready;
    const row = await db.get(
      `SELECT COALESCE(SUM(usd), 0) as total_usd, COALESCE(SUM(somoni), 0) as total_somoni, COUNT(*) as count
       FROM cash_records WHERE created_at >= datetime('now', '-' || ? || ' days')`,
      [days]
    );
    return row || { total_usd: 0, total_somoni: 0, count: 0 };
  }

  // ── Отчёт кассы по конкретному создателю (для клиентов-операторов) ──────────
  async getCashReportByCreator(creatorId) {
    await db._ready;
    return db.all(
      'SELECT client_name, client_phone, mode, usd, somoni, rate, comment, created_at FROM cash_records WHERE admin_id = ? ORDER BY created_at DESC',
      [creatorId]
    );
  }

  async getCashTotalsByCreator(creatorId) {
    await db._ready;
    const row = await db.get(
      'SELECT COALESCE(SUM(usd), 0) as total_usd, COALESCE(SUM(somoni), 0) as total_somoni, COUNT(*) as count FROM cash_records WHERE admin_id = ?',
      [creatorId]
    );
    return row || { total_usd: 0, total_somoni: 0, count: 0 };
  }

  async getCashSummary(days) {
    await db._ready;
    let whereClause = '';
    const params = [];
    if (days) {
      whereClause = `WHERE created_at >= datetime('now', '-' || ? || ' days')`;
      params.push(days);
    }

    const monthly = await db.all(
      `SELECT strftime('%Y-%m', created_at) as month,
              COALESCE(SUM(usd), 0) as usd,
              COALESCE(SUM(somoni), 0) as somoni,
              COUNT(*) as count
       FROM cash_records ${whereClause}
       GROUP BY month ORDER BY month DESC`,
      params
    );

    const totals = await db.get(
      `SELECT COALESCE(SUM(usd), 0) as total_usd, COALESCE(SUM(somoni), 0) as total_somoni, COUNT(*) as count
       FROM cash_records ${whereClause}`,
      params
    );

    return {
      monthly,
      totals: totals || { total_usd: 0, total_somoni: 0, count: 0 }
    };
  }

  async getStats() {
    await db._ready;
    const clients = await db.get('SELECT COUNT(*) as count FROM clients WHERE is_active = 1');
    const orders = await db.get('SELECT COUNT(*) as count FROM orders WHERE is_deleted = 0');
    const todayOrders = await db.get(
      "SELECT COUNT(*) as count FROM orders WHERE is_deleted = 0 AND date(created_at) = date('now')"
    );
    return {
      totalClients: clients.count,
      totalOrders: orders.count,
      todayOrders: todayOrders.count
    };
  }

  async getDetailedOrderStats() {
    await db._ready;
    return db.all(
      `SELECT o.warehouse, COUNT(*) as count FROM orders o
       WHERE o.is_deleted = 0
       GROUP BY o.warehouse ORDER BY count DESC`
    );
  }

  async getRecentOrdersWithClients(limit = 10) {
    await db._ready;
    return db.all(
      `SELECT o.*, u.name as client_name, u.phone as client_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.is_deleted = 0
       ORDER BY o.created_at DESC LIMIT ?`,
      [limit]
    );
  }

  async getWarehouseStats() {
    await db._ready;
    return db.all(
      `SELECT warehouse, COUNT(*) as count FROM orders
       WHERE is_deleted = 0 GROUP BY warehouse ORDER BY count DESC`
    );
  }

  async close() {
    db.db.close();
  }
}

module.exports = new Database();
