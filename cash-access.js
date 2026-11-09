/**
 * Функции доступа к кассе для клиентов
 * Отдельный файл чтобы избежать кеширования Railway
 */

const database = require('./database-wrapper');

// Проверка доступа к кассе
async function hasCashAccess(telegramId) {
  try {
    const pool = database.pool;
    if (!pool) {
      // SQLite fallback
      return await database.hasCashAccess(telegramId);
    }
    const result = await pool.query(
      'SELECT cash_access FROM clients WHERE telegram_id = $1 AND is_active = 1',
      [telegramId]
    );
    return result.rows.length > 0 && result.rows[0].cash_access === 1;
  } catch (e) {
    try {
      return await database.hasCashAccess(telegramId);
    } catch (e2) {
      return false;
    }
  }
}

// Выдать доступ
async function grantCashAccess(telegramId) {
  try {
    const pool = database.pool;
    if (!pool) return await database.grantCashAccess(telegramId);
    const result = await pool.query(
      'UPDATE clients SET cash_access = 1 WHERE telegram_id = $1 AND is_active = 1',
      [telegramId]
    );
    return result.rowCount > 0;
  } catch (e) {
    return await database.grantCashAccess(telegramId);
  }
}

// Забрать доступ
async function revokeCashAccess(telegramId) {
  try {
    const pool = database.pool;
    if (!pool) return await database.revokeCashAccess(telegramId);
    const result = await pool.query(
      'UPDATE clients SET cash_access = 0 WHERE telegram_id = $1',
      [telegramId]
    );
    return result.rowCount > 0;
  } catch (e) {
    return await database.revokeCashAccess(telegramId);
  }
}

// Список клиентов с доступом
async function getClientsWithCashAccess() {
  try {
    const pool = database.pool;
    if (!pool) return await database.getClientsWithCashAccess();
    const result = await pool.query(
      'SELECT telegram_id, name, phone FROM clients WHERE is_active = 1 AND cash_access = 1 ORDER BY name'
    );
    return result.rows;
  } catch (e) {
    return await database.getClientsWithCashAccess();
  }
}

// Отчёт кассы по создателю
async function getCashReportByCreator(creatorId) {
  try {
    const pool = database.pool;
    if (!pool) return await database.getCashReportByCreator(creatorId);
    const result = await pool.query(
      `SELECT client_name, client_phone, mode, usd, somoni, rate, comment, created_at
       FROM cash_records WHERE admin_id = $1 ORDER BY created_at DESC`,
      [creatorId]
    );
    return result.rows;
  } catch (e) {
    return await database.getCashReportByCreator(creatorId);
  }
}

// Итоги по создателю
async function getCashTotalsByCreator(creatorId) {
  try {
    const pool = database.pool;
    if (!pool) return await database.getCashTotalsByCreator(creatorId);
    const result = await pool.query(
      `SELECT COALESCE(SUM(usd), 0) AS total_usd,
              COALESCE(SUM(somoni), 0) AS total_somoni,
              COUNT(*) AS count
       FROM cash_records WHERE admin_id = $1`,
      [creatorId]
    );
    return result.rows[0];
  } catch (e) {
    return await database.getCashTotalsByCreator(creatorId);
  }
}

module.exports = {
  hasCashAccess,
  grantCashAccess,
  revokeCashAccess,
  getClientsWithCashAccess,
  getCashReportByCreator,
  getCashTotalsByCreator
};
