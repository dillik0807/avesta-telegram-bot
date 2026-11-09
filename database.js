const { Pool } = require('pg');

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

class Database {
  constructor() {
    this.pool = pool;
    console.log('✅ PostgreSQL подключен');
    this.init();
  }

  async init() {
    try {
      // Таблица пользователей
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          telegram_id BIGINT UNIQUE NOT NULL,
          name TEXT,
          phone TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица запросов на регистрацию
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS registration_requests (
          id SERIAL PRIMARY KEY,
          telegram_id BIGINT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          username TEXT,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица клиентов
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS clients (
          id SERIAL PRIMARY KEY,
          telegram_id BIGINT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          phone TEXT,
          added_by BIGINT NOT NULL,
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица заявок
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          warehouse TEXT,
          transport_number TEXT,
          comment TEXT,
          status TEXT DEFAULT 'new',
          is_deleted INTEGER DEFAULT 0,
          deleted_at TIMESTAMP,
          deleted_by TEXT,
          restored_at TIMESTAMP,
          restored_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Таблица товаров в заявке
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS order_items (
          id SERIAL PRIMARY KEY,
          order_id INTEGER NOT NULL,
          product_name TEXT NOT NULL,
          quantity TEXT NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id)
        )
      `);

      // Таблица складов
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS warehouses (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          whatsapp_group_id TEXT,
          whatsapp_phone TEXT,
          green_api_instance_id TEXT,
          green_api_token TEXT,
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Миграция: добавляем все недостающие колонки в warehouses и products
      const warehouseColumns = [
        { name: 'whatsapp_group_id', type: 'TEXT' },
        { name: 'whatsapp_phone', type: 'TEXT' },
        { name: 'green_api_instance_id', type: 'TEXT' },
        { name: 'green_api_token', type: 'TEXT' },
        { name: 'is_active', type: 'INTEGER DEFAULT 1' }
      ];
      
      for (const col of warehouseColumns) {
        try {
          const check = await this.pool.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'warehouses' AND column_name = $1
          `, [col.name]);
          if (check.rows.length === 0) {
            await this.pool.query(`ALTER TABLE warehouses ADD COLUMN ${col.name} ${col.type}`);
            console.log(`✅ Колонка warehouses.${col.name} добавлена`);
          }
        } catch (e) {
          console.log(`⚠️ Ошибка добавления warehouses.${col.name}: ${e.message}`);
        }
      }

      // Миграция: is_active для products
      try {
        const check = await this.pool.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'products' AND column_name = 'is_active'
        `);
        if (check.rows.length === 0) {
          await this.pool.query(`ALTER TABLE products ADD COLUMN is_active INTEGER DEFAULT 1`);
          console.log('✅ Колонка products.is_active добавлена');
        }
      } catch (e) {
        console.log(`⚠️ Ошибка добавления products.is_active: ${e.message}`);
      }

      // Миграция: is_active для clients
      try {
        const check = await this.pool.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'clients' AND column_name = 'is_active'
        `);
        if (check.rows.length === 0) {
          await this.pool.query(`ALTER TABLE clients ADD COLUMN is_active INTEGER DEFAULT 1`);
          console.log('✅ Колонка clients.is_active добавлена');
        }
      } catch (e) {
        console.log(`⚠️ Ошибка добавления clients.is_active: ${e.message}`);
      }

      // Миграция: cash_access для clients
      try {
        const check = await this.pool.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'clients' AND column_name = 'cash_access'
        `);
        if (check.rows.length === 0) {
          await this.pool.query(`ALTER TABLE clients ADD COLUMN cash_access INTEGER DEFAULT 0`);
          console.log('✅ Колонка clients.cash_access добавлена');
        }
      } catch (e) {
        console.log(`⚠️ Ошибка добавления clients.cash_access: ${e.message}`);
      }

      // Таблица товаров
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          is_active INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Таблица записей кассы
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS cash_records (
          id SERIAL PRIMARY KEY,
          client_id BIGINT,
          client_name TEXT,
          client_phone TEXT,
          mode TEXT NOT NULL,
          usd NUMERIC DEFAULT 0,
          somoni NUMERIC DEFAULT 0,
          rate NUMERIC DEFAULT 0,
          admin_id BIGINT,
          comment TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Миграция: добавить колонку comment если её нет
      await this.pool.query(`ALTER TABLE cash_records ADD COLUMN IF NOT EXISTS comment TEXT`).catch(() => {});

      // Таблица дат передачи отчёта кассиру
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS cash_report_sent (
          id SERIAL PRIMARY KEY,
          sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      console.log('✅ Таблицы PostgreSQL инициализированы');
    } catch (error) {
      // Тихо — при локальном запуске railway.internal недоступен, wrapper переключит на SQLite
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || String(error.message).includes('railway.internal')) {
        console.log('⚠️  PostgreSQL (railway.internal) недоступен локально — используется SQLite');
      } else {
        console.error('❌ Ошибка инициализации таблиц:', error.message);
      }
    }
  }

  async getOrCreateUser(telegramId, name, phone) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [telegramId]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0];
      } else {
        const insertResult = await this.pool.query(
          'INSERT INTO users (telegram_id, name, phone) VALUES ($1, $2, $3) RETURNING *',
          [telegramId, name, phone]
        );
        return insertResult.rows[0];
      }
    } catch (error) {
      throw error;
    }
  }

  async createOrder(userId, warehouse, transportNumber, comment) {
    try {
      const result = await this.pool.query(
        'INSERT INTO orders (user_id, warehouse, transport_number, comment) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, warehouse, transportNumber, comment]
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async addOrderItem(orderId, productName, quantity) {
    try {
      const result = await this.pool.query(
        'INSERT INTO order_items (order_id, product_name, quantity) VALUES ($1, $2, $3) RETURNING id',
        [orderId, productName, quantity]
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async getOrderWithItems(orderId) {
    try {
      const orderResult = await this.pool.query(
        'SELECT * FROM orders WHERE id = $1',
        [orderId]
      );
      
      const itemsResult = await this.pool.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [orderId]
      );
      
      return { ...orderResult.rows[0], items: itemsResult.rows };
    } catch (error) {
      throw error;
    }
  }

  async addClient(telegramId, name, phone, addedBy) {
    try {
      const result = await this.pool.query(
        'INSERT INTO clients (telegram_id, name, phone, added_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [telegramId, name || '', phone || '', addedBy]
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async isClient(telegramId) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM clients WHERE telegram_id = $1 AND is_active = 1',
        [telegramId]
      );
      return result.rows.length > 0;
    } catch (error) {
      throw error;
    }
  }

  async getAllClients() {
    try {
      const result = await this.pool.query(
        'SELECT * FROM clients WHERE is_active = 1 ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async removeClient(telegramId) {
    try {
      const result = await this.pool.query(
        'UPDATE clients SET is_active = 0 WHERE telegram_id = $1',
        [telegramId]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  // ── Доступ к кассе для клиентов ──────────────────────────────────────────────
  async hasCashAccess(telegramId) {
    try {
      const result = await this.pool.query(
        'SELECT cash_access FROM clients WHERE telegram_id = $1 AND is_active = 1',
        [telegramId]
      );
      return result.rows.length > 0 && result.rows[0].cash_access === 1;
    } catch (error) {
      return false;
    }
  }

  async grantCashAccess(telegramId) {
    try {
      const result = await this.pool.query(
        'UPDATE clients SET cash_access = 1 WHERE telegram_id = $1 AND is_active = 1',
        [telegramId]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async revokeCashAccess(telegramId) {
    try {
      const result = await this.pool.query(
        'UPDATE clients SET cash_access = 0 WHERE telegram_id = $1',
        [telegramId]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async getClientsWithCashAccess() {
    try {
      const result = await this.pool.query(
        'SELECT telegram_id, name, phone FROM clients WHERE is_active = 1 AND cash_access = 1 ORDER BY name'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async getStats() {
    try {
      const clientsResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM clients WHERE is_active = 1'
      );
      
      const ordersResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM orders WHERE is_deleted = 0 OR is_deleted IS NULL'
      );
      
      const todayResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURRENT_DATE AND (is_deleted = 0 OR is_deleted IS NULL)'
      );
      
      const weekResult = await this.pool.query(
        'SELECT COUNT(*) as count FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL \'7 days\' AND (is_deleted = 0 OR is_deleted IS NULL)'
      );
      
      return {
        totalClients: parseInt(clientsResult.rows[0].count),
        totalOrders: parseInt(ordersResult.rows[0].count),
        ordersToday: parseInt(todayResult.rows[0].count),
        ordersWeek: parseInt(weekResult.rows[0].count)
      };
    } catch (error) {
      throw error;
    }
  }

  async getDetailedOrderStats() {
    try {
      const result = await this.pool.query(`
        SELECT 
          c.id as client_id,
          c.name as client_name,
          c.phone,
          c.telegram_id,
          COUNT(o.id) as orders_count,
          MAX(o.created_at) as last_order_date,
          MIN(o.created_at) as first_order_date
        FROM clients c
        LEFT JOIN orders o ON c.id = o.client_id 
          AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
        WHERE c.is_active = 1
        GROUP BY c.id, c.name, c.phone, c.telegram_id
        ORDER BY orders_count DESC, last_order_date DESC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async getRecentOrdersWithClients(limit = 10) {
    try {
      const result = await this.pool.query(`
        SELECT 
          o.id,
          o.warehouse,
          o.transport_number,
          o.comment,
          o.status,
          o.created_at,
          c.name as client_name,
          c.telegram_id,
          c.phone
        FROM orders o
        JOIN users u ON o.user_id = u.id
        JOIN clients c ON u.telegram_id = c.telegram_id
        WHERE c.is_active = 1 AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
        ORDER BY o.created_at DESC
        LIMIT $1
      `, [limit]);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseStats() {
    try {
      const result = await this.pool.query(`
        SELECT 
          warehouse,
          COUNT(*) as orders_count,
          COUNT(DISTINCT user_id) as unique_clients,
          MAX(created_at) as last_order_date
        FROM orders 
        WHERE (is_deleted = 0 OR is_deleted IS NULL)
        GROUP BY warehouse
        ORDER BY orders_count DESC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async createRegistrationRequest(telegramId, name, username) {
    try {
      const result = await this.pool.query(
        'INSERT INTO registration_requests (telegram_id, name, username) VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO UPDATE SET name = $2, username = $3 RETURNING id',
        [telegramId, name, username || '']
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async getRegistrationRequest(telegramId) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM registration_requests WHERE telegram_id = $1 AND status = $2',
        [telegramId, 'pending']
      );
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  async getPendingRequests() {
    try {
      const result = await this.pool.query(
        'SELECT * FROM registration_requests WHERE status = $1 ORDER BY created_at DESC',
        ['pending']
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  async getPendingRequest(telegramId) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM registration_requests WHERE telegram_id = $1 AND status = $2',
        [telegramId, 'pending']
      );
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  async approveClient(telegramId, name, phone, approvedBy) {
    try {
      await this.pool.query(
        'INSERT INTO clients (telegram_id, name, phone, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (telegram_id) DO NOTHING',
        [telegramId, name, phone, approvedBy]
      );
      
      await this.pool.query(
        'UPDATE registration_requests SET status = $1 WHERE telegram_id = $2',
        ['approved', telegramId]
      );
      
      return true;
    } catch (error) {
      throw error;
    }
  }

  async rejectRequest(telegramId) {
    try {
      const result = await this.pool.query(
        'UPDATE registration_requests SET status = $1 WHERE telegram_id = $2',
        ['rejected', telegramId]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async getClient(telegramId) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM clients WHERE telegram_id = $1 AND is_active = 1',
        [telegramId]
      );
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  async updateClient(telegramId, name, phone) {
    try {
      const result = await this.pool.query(
        'UPDATE clients SET name = $1, phone = $2 WHERE telegram_id = $3',
        [name, phone, telegramId]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async addWarehouse(name, whatsappGroupId = null) {
    try {
      const result = await this.pool.query(
        'INSERT INTO warehouses (name, whatsapp_group_id) VALUES ($1, $2) RETURNING id',
        [name, whatsappGroupId]
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async updateWarehouseWhatsApp(warehouseName, whatsappGroupId) {
    try {
      const result = await this.pool.query(
        'UPDATE warehouses SET whatsapp_group_id = $1 WHERE name = $2',
        [whatsappGroupId, warehouseName]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseWhatsApp(warehouseName) {
    try {
      const result = await this.pool.query(
        'SELECT whatsapp_group_id FROM warehouses WHERE name = $1',
        [warehouseName]
      );
      return result.rows[0] ? result.rows[0].whatsapp_group_id : null;
    } catch (error) {
      throw error;
    }
  }

  async updateWarehouseWhatsAppPhone(warehouseName, whatsappPhone) {
    try {
      const result = await this.pool.query(
        'UPDATE warehouses SET whatsapp_phone = $1 WHERE name = $2',
        [whatsappPhone, warehouseName]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseWhatsAppPhone(warehouseName) {
    try {
      const result = await this.pool.query(
        'SELECT whatsapp_phone FROM warehouses WHERE name = $1',
        [warehouseName]
      );
      return result.rows[0] ? result.rows[0].whatsapp_phone : null;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseWhatsAppSettings(warehouseName) {
    try {
      const result = await this.pool.query(
        'SELECT whatsapp_group_id, whatsapp_phone, green_api_instance_id, green_api_token FROM warehouses WHERE name = $1',
        [warehouseName]
      );
      return result.rows[0] || { 
        whatsapp_group_id: null, 
        whatsapp_phone: null,
        green_api_instance_id: null,
        green_api_token: null
      };
    } catch (error) {
      throw error;
    }
  }

  async updateWarehouseGreenApi(warehouseName, instanceId, token) {
    try {
      const result = await this.pool.query(
        'UPDATE warehouses SET green_api_instance_id = $1, green_api_token = $2 WHERE name = $3',
        [instanceId, token, warehouseName]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async getAllWarehouses() {
    try {
      const result = await this.pool.query(
        'SELECT * FROM warehouses WHERE is_active = 1 OR is_active IS NULL ORDER BY name'
      );
      return result.rows;
    } catch (error) {
      // Если колонки is_active нет — вернуть все
      const result = await this.pool.query('SELECT * FROM warehouses ORDER BY name');
      return result.rows;
    }
  }

  async removeWarehouse(id) {
    try {
      const result = await this.pool.query(
        'UPDATE warehouses SET is_active = 0 WHERE id = $1',
        [id]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  async addProduct(name) {
    try {
      const result = await this.pool.query(
        'INSERT INTO products (name) VALUES ($1) RETURNING id',
        [name]
      );
      return result.rows[0].id;
    } catch (error) {
      throw error;
    }
  }

  async getAllProducts() {
    try {
      const result = await this.pool.query(
        'SELECT * FROM products WHERE is_active = 1 OR is_active IS NULL ORDER BY name'
      );
      return result.rows;
    } catch (error) {
      // Если колонки is_active нет — вернуть все
      const result = await this.pool.query('SELECT * FROM products ORDER BY name');
      return result.rows;
    }
  }

  async removeProduct(id) {
    try {
      const result = await this.pool.query(
        'UPDATE products SET is_active = 0 WHERE id = $1',
        [id]
      );
      return result.rowCount > 0;
    } catch (error) {
      throw error;
    }
  }

  // Методы мягкого удаления
  async softDeleteOrder(orderId, deletedBy = 'admin') {
    try {
      const result = await this.pool.query(
        'UPDATE orders SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = $1 WHERE id = $2',
        [deletedBy, orderId]
      );
      console.log(`✅ Заявка ${orderId} помечена как удаленная`);
      return result.rowCount > 0;
    } catch (error) {
      console.error('❌ Ошибка мягкого удаления заявки:', error);
      throw error;
    }
  }

  async restoreOrder(orderId, restoredBy = 'admin') {
    try {
      const result = await this.pool.query(
        'UPDATE orders SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, restored_at = CURRENT_TIMESTAMP, restored_by = $1 WHERE id = $2',
        [restoredBy, orderId]
      );
      console.log(`✅ Заявка ${orderId} восстановлена из корзины`);
      return result.rowCount > 0;
    } catch (error) {
      console.error('❌ Ошибка восстановления заявки:', error);
      throw error;
    }
  }

  async getDeletedOrders() {
    try {
      const result = await this.pool.query(`
        SELECT o.*, c.name as client_name, c.phone 
        FROM orders o
        LEFT JOIN clients c ON o.client_id = c.id
        WHERE o.is_deleted = 1
        ORDER BY o.deleted_at DESC
      `);
      console.log(`📊 Найдено удаленных заявок: ${result.rows.length}`);
      return result.rows;
    } catch (error) {
      console.error('❌ Ошибка получения удаленных заявок:', error);
      throw error;
    }
  }

  async getClientOrders(clientTelegramId, limit = 5) {
    try {
      const result = await this.pool.query(`
        SELECT o.id, o.warehouse, o.transport_number, o.comment, o.created_at,
               array_agg(oi.product_name || ' — ' || oi.quantity ORDER BY oi.id) as items
        FROM orders o
        JOIN users u ON o.user_id = u.id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE u.telegram_id = $1 AND (o.is_deleted = 0 OR o.is_deleted IS NULL)
        GROUP BY o.id, o.warehouse, o.transport_number, o.comment, o.created_at
        ORDER BY o.created_at DESC
        LIMIT $2
      `, [clientTelegramId, limit]);
      return result.rows;
    } catch (error) {
      console.error('❌ Ошибка получения заявок клиента:', error);
      return [];
    }
  }

  async addCashRecord(clientId, clientName, clientPhone, mode, usd, somoni, rate, adminId, comment) {
    try {
      await this.pool.query(
        `INSERT INTO cash_records (client_id, client_name, client_phone, mode, usd, somoni, rate, admin_id, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [clientId, clientName, clientPhone, mode, usd || 0, somoni || 0, rate || 0, adminId, comment || null]
      ).catch(async () => {
        // Если колонки comment нет — добавляем её и повторяем
        await this.pool.query(`ALTER TABLE cash_records ADD COLUMN IF NOT EXISTS comment TEXT`);
        await this.pool.query(
          `INSERT INTO cash_records (client_id, client_name, client_phone, mode, usd, somoni, rate, admin_id, comment)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [clientId, clientName, clientPhone, mode, usd || 0, somoni || 0, rate || 0, adminId, comment || null]
        );
      });
      return true;
    } catch (error) {
      console.error('❌ Ошибка сохранения записи кассы:', error);
      return false;
    }
  }

  async getLastCashReportSent() {
    try {
      const result = await this.pool.query(
        `SELECT sent_at FROM cash_report_sent ORDER BY sent_at DESC LIMIT 1`
      );
      return result.rows.length > 0 ? result.rows[0].sent_at : null;
    } catch (error) {
      console.error('❌ Ошибка получения даты передачи:', error);
      return null;
    }
  }

  async markCashReportSent() {
    try {
      await this.pool.query(`INSERT INTO cash_report_sent DEFAULT VALUES`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка сохранения даты передачи:', error);
      return false;
    }
  }

  async getCashSummary(days) {
    try {
      const where = days ? `WHERE created_at >= NOW() - INTERVAL '${days} days'` : '';
      // Итоги по периоду
      const totals = await this.pool.query(`
        SELECT 
          COALESCE(SUM(usd), 0) AS total_usd,
          COALESCE(SUM(somoni), 0) AS total_somoni,
          COUNT(*) AS count
        FROM cash_records ${where}
      `);
      // Итоги по месяцам
      const monthly = await this.pool.query(`
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM') AS month,
          COALESCE(SUM(usd), 0) AS usd,
          COALESCE(SUM(somoni), 0) AS somoni,
          COUNT(*) AS count
        FROM cash_records ${where}
        GROUP BY month
        ORDER BY month DESC
      `);
      return { totals: totals.rows[0], monthly: monthly.rows };
    } catch (error) {
      console.error('❌ Ошибка сводного отчёта:', error);
      return { totals: { total_usd: 0, total_somoni: 0, count: 0 }, monthly: [] };
    }
  }

  async getCashReport(days) {
    try {
      const lastSent = await this.getLastCashReportSent();
      let whereClause;
      let params = [];
      if (lastSent) {
        whereClause = `WHERE created_at > $1`;
        params = [lastSent];
      } else {
        whereClause = `WHERE created_at >= NOW() - INTERVAL '${days} days'`;
      }
      const result = await this.pool.query(`
        SELECT client_name, client_phone, mode, usd, somoni, rate, comment, created_at
        FROM cash_records
        ${whereClause}
        ORDER BY created_at DESC
      `, params);
      return result.rows;
    } catch (error) {
      console.error('❌ Ошибка получения отчёта кассы:', error);
      return [];
    }
  }

  async getCashTotals(days = 7) {
    try {
      const lastSent = await this.getLastCashReportSent();
      let whereClause;
      let params = [];
      if (lastSent) {
        whereClause = `WHERE created_at > $1`;
        params = [lastSent];
      } else {
        whereClause = `WHERE created_at >= NOW() - INTERVAL '${days} days'`;
      }
      const result = await this.pool.query(`
        SELECT 
          COALESCE(SUM(usd), 0) AS total_usd,
          COALESCE(SUM(somoni), 0) AS total_somoni,
          COUNT(*) AS count
        FROM cash_records
        ${whereClause}
      `, params);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Ошибка получения итогов кассы:', error);
      return { total_usd: 0, total_somoni: 0, count: 0 };
    }
  }

  // ── Отчёт кассы по конкретному создателю (для клиентов-операторов) ──────────
  async getCashReportByCreator(creatorId) {
    try {
      const result = await this.pool.query(`
        SELECT client_name, client_phone, mode, usd, somoni, rate, comment, created_at
        FROM cash_records
        WHERE admin_id = $1
        ORDER BY created_at DESC
      `, [creatorId]);
      return result.rows;
    } catch (error) {
      console.error('❌ Ошибка получения отчёта по создателю:', error);
      return [];
    }
  }

  async getCashTotalsByCreator(creatorId) {
    try {
      const result = await this.pool.query(`
        SELECT 
          COALESCE(SUM(usd), 0) AS total_usd,
          COALESCE(SUM(somoni), 0) AS total_somoni,
          COUNT(*) AS count
        FROM cash_records
        WHERE admin_id = $1
      `, [creatorId]);
      return result.rows[0];
    } catch (error) {
      console.error('❌ Ошибка получения итогов по создателю:', error);
      return { total_usd: 0, total_somoni: 0, count: 0 };
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = new Database();
