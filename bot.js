require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
// Автоматический выбор: PostgreSQL если DATABASE_URL задан, иначе SQLite
const database = require('./database-wrapper');
const whatsapp = require('./whatsapp');
const admin = require('./admin');
const dataManager = require('./data-manager');
const cashAccess = require('./cash-access');

// 🔧 Автоматическая миграция PostgreSQL при запуске
async function autoMigrate() {
  if (process.env.DATABASE_URL) {
    console.log('🔄 Проверка необходимости миграции PostgreSQL...');
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      
      const client = await pool.connect();
      
      // Проверяем наличие колонки is_deleted
      const checkResult = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'orders' AND column_name = 'is_deleted'
      `);
      
      if (checkResult.rows.length === 0) {
        console.log('⚠️ Колонки отсутствуют, выполняем миграцию...');
        
        // Добавляем колонки
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_deleted INTEGER DEFAULT 0');
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP');
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by TEXT');
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS restored_at TIMESTAMP');
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS restored_by TEXT');
        await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id INTEGER');
        
        console.log('✅ Колонки добавлены');
        
        // Заполняем client_id
        const updateResult = await client.query(`
          UPDATE orders o
          SET client_id = (
            SELECT c.id 
            FROM users u 
            JOIN clients c ON u.telegram_id = c.telegram_id 
            WHERE u.id = o.user_id
          )
          WHERE client_id IS NULL
        `);
        console.log(`✅ Обновлено записей: ${updateResult.rowCount}`);
        
        // Добавляем whatsapp_group_id
        await client.query('ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS whatsapp_group_id TEXT');
        
        // Настраиваем маршрутизацию
        await client.query("UPDATE warehouses SET whatsapp_group_id = '120363419535622239@g.us' WHERE name = 'ЧБалхи'");
        await client.query("UPDATE warehouses SET whatsapp_group_id = '120363422710745455@g.us' WHERE name = 'ЗаводТЧ'");
        
        console.log('✅ Маршрутизация настроена');
        console.log('🎉 Автоматическая миграция завершена!');
      } else {
        console.log('✅ Миграция не требуется - все колонки на месте');
      }
      
      client.release();
      await pool.end();
    } catch (error) {
      console.error('⚠️ Ошибка автоматической миграции:', error.message);
      console.log('💡 Выполните миграцию вручную: npm run migrate-postgres');
    }
  }
}

// 🔧 Загружаем исправления для Order Bot (только если используется SQLite)
try {
  if (process.env.DB_PATH && !process.env.DATABASE_URL) {
    const orderBotFixes = require('./fix-order-bot-soft-delete');
    console.log('🔧 Исправления Order Bot загружены (SQLite)');
  } else {
    console.log('🔧 Используется PostgreSQL - исправления встроены');
  }
} catch (error) {
  console.log('⚠️ Исправления Order Bot не загружены:', error.message);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Настройка команд администратора
admin.setupAdminCommands(bot);

// Временное хранилище данных заявки
const orderData = new Map();

// Очистка устаревших данных заявок (старше 6 часов)
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of orderData.entries()) {
    if (data.createdAt && (now - data.createdAt) > 6 * 60 * 60 * 1000) {
      orderData.delete(userId);
      console.log(`🧹 Очищены устаревшие данные заявки для пользователя ${userId}`);
    }
  }
}, 30 * 60 * 1000); // Проверяем каждые 30 минут

// Загрузка складов и товаров из БД через менеджер данных
async function loadWarehousesAndProducts() {
  // 🚀 Простая миграция через существующее подключение
  try {
    console.log('🔧 Проверка и настройка маршрутизации...');
    
    // Проверяем, нужна ли миграция
    let needsMigration = false;
    try {
      // Пробуем получить WhatsApp группу - если ошибка, значит колонки нет
      await database.getWarehouseWhatsApp('ЧБалхи');
      console.log('✅ Колонка whatsapp_group_id существует');
    } catch (error) {
      if (error.code === 'SQLITE_ERROR' && error.message.includes('no such column')) {
        needsMigration = true;
        console.log('⚠️ Колонка whatsapp_group_id не найдена, нужна миграция');
      } else {
        console.log('⚠️ Другая ошибка при проверке колонки:', error.message);
      }
    }
    
    // Если нужна миграция, выполняем её через отдельное подключение
    if (needsMigration) {
      console.log('➕ Выполняем миграцию базы данных...');
      
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = process.env.DB_PATH || './orders.db';
      
      await new Promise((resolve, reject) => {
        const migrationDb = new sqlite3.Database(dbPath, (err) => {
          if (err) {
            console.error('❌ Ошибка подключения для миграции:', err);
            reject(err);
            return;
          }
          
          console.log('✅ Подключение для миграции создано');
          
          // Добавляем колонку
          migrationDb.run("ALTER TABLE warehouses ADD COLUMN whatsapp_group_id TEXT", (err) => {
            migrationDb.close(); // Сразу закрываем миграционное подключение
            
            if (err) {
              console.error('❌ Ошибка добавления колонки:', err);
              reject(err);
            } else {
              console.log('✅ Колонка whatsapp_group_id добавлена!');
              resolve();
            }
          });
        });
      });
      
      // Небольшая задержка после миграции
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Настраиваем маршрутизацию через основное подключение database.js
    console.log('🎯 Настройка маршрутизации складов...');
    
    try {
      const balkhiUpdated = await database.updateWarehouseWhatsApp('ЧБалхи', '120363419535622239@g.us');
      if (balkhiUpdated) {
        console.log('✅ ЧБалхи → Бахор ойл склад');
      } else {
        console.log('⚠️ Склад ЧБалхи не найден');
      }
    } catch (error) {
      console.log('❌ Ошибка настройки ЧБалхи:', error.message);
    }
    
    try {
      const zavodUpdated = await database.updateWarehouseWhatsApp('ЗаводТЧ', '120363422710745455@g.us');
      if (zavodUpdated) {
        console.log('✅ ЗаводТЧ → точик азод');
      } else {
        console.log('⚠️ Склад ЗаводТЧ не найден');
      }
    } catch (error) {
      console.log('❌ Ошибка настройки ЗаводТЧ:', error.message);
    }
    
    console.log('🎉 Настройка маршрутизации завершена!');
    
  } catch (error) {
    console.log('⚠️ Ошибка настройки маршрутизации:', error.message);
  }
  
  // Загружаем данные через dataManager
  return await dataManager.loadWarehousesAndProducts();
}

// 🔄 Функция для принудительного обновления данных
async function reloadWarehousesAndProducts() {
  console.log('🔄 Принудительное обновление данных складов и товаров...');
  try {
    await dataManager.loadWarehousesAndProducts();
    console.log('✅ Данные обновлены успешно');
  } catch (error) {
    console.error('❌ Ошибка обновления данных:', error);
  }
}

// Геттеры для получения текущих данных
function getWarehouses() {
  return dataManager.warehouses;
}

function getProducts() {
  return dataManager.products;
}

// Загружаем при старте
setTimeout(loadWarehousesAndProducts, 1000);

// Форматирование заявки для отправки
function formatOrder(orderInfo) {
  let message = '📦 НОВАЯ ЗАЯВКА\n\n';
  message += `👤 Клиент: ${orderInfo.name}\n`;
  message += `📞 Телефон: ${orderInfo.phone}\n`;
  message += `🏬 Склад: ${orderInfo.warehouse}\n\n`;
  message += `🛒 Товары:\n`;
  
  let totalQuantity = 0;
  
  orderInfo.items.forEach((item, index) => {
    message += `${index + 1}) ${item.product} — ${item.quantity}\n`;
    
    // Извлекаем число из quantity для подсчета итога
    const quantityMatch = item.quantity.match(/(\d+)/);
    if (quantityMatch) {
      totalQuantity += parseInt(quantityMatch[1]);
    }
  });
  
  message += `\n📊 Итого: ${totalQuantity} шт\n`;
  message += `\n🚚 Транспорт: ${orderInfo.transport}\n`;
  
  if (orderInfo.comment) {
    message += `📝 Комментарий: ${orderInfo.comment}\n`;
  }
  
  message += `\n📅 Дата: ${new Date().toLocaleDateString('ru-RU')} ${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}`;
  
  return message;
}

// Команда /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || ctx.from.username || 'Пользователь';
  
  // Сбрасываем незавершённую заявку
  orderData.delete(userId);
  
  // Проверка прав доступа
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  
  if (isAdminUser) {
    const keyboard = [
      [{ text: '📦 Создать заявку' }],
      [{ text: '💰 Касса' }],
      [{ text: '👨‍💼 Панель администратора' }]
    ];
    
    return ctx.reply(
      '👋 Добро пожаловать, администратор!\n\n' +
      'Выберите действие:',
      { reply_markup: { keyboard, resize_keyboard: true } }
    );
  }
  
  if (isClientUser) {
    // Проверяем есть ли доступ к кассе
    const hasCash = await cashAccess.hasCashAccess(userId);
    const keyboard = [
      [{ text: '🏬 Склад' }]
    ];
    if (hasCash) {
      keyboard.push([{ text: '💰 Касса' }]);
      keyboard.push([{ text: '📊 Мои записи кассы' }]);
    }
    
    return ctx.reply(
      '👋 Добро пожаловать в систему приема заявок!\n\n' +
      'Нажмите "🏬 Склад" чтобы создать заявку' + (hasCash ? '\n"💰 Касса" — инкассо кассиру\n"📊 Мои записи кассы" — ваши записи' : ''),
      { reply_markup: { keyboard, resize_keyboard: true } }
    );
  }
  
  // Пользователь не зарегистрирован - отправляем запрос администратору
  const pendingRequest = await database.getPendingRequest(userId);
  
  if (pendingRequest) {
    return ctx.reply(
      '⏳ Ваш запрос на регистрацию уже отправлен администратору.\n\n' +
      'Пожалуйста, ожидайте подтверждения.'
    );
  }
  
  // Создаем запрос на регистрацию
  await database.createRegistrationRequest(userId, userName, ctx.from.username);
  
  ctx.reply(
    '📝 Ваш запрос на регистрацию отправлен администратору.\n\n' +
    'Вы получите уведомление, когда администратор одобрит вашу заявку.\n\n' +
    'Ваш Telegram ID: ' + userId
  );
  
  // Уведомление всем администраторам
  for (const adminId of admin.ADMINS) {
    try {
      const keyboard = [
        [{ text: `✅ Одобрить ${userName}`, callback_data: `approve_${userId}` }],
        [{ text: `❌ Отклонить ${userName}`, callback_data: `reject_${userId}` }]
      ];
      
      await bot.telegram.sendMessage(
        adminId,
        '🔔 Новый запрос на регистрацию!\n\n' +
        `👤 Имя: ${userName}\n` +
        `🆔 Telegram ID: ${userId}\n` +
        `📱 Username: @${ctx.from.username || 'не указан'}\n\n` +
        'Одобрить регистрацию?',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Одобрить', callback_data: `approve_${userId}` },
                { text: '❌ Отклонить', callback_data: `reject_${userId}` }
              ]
            ]
          }
        }
      );
    } catch (error) {
      console.error('Ошибка отправки уведомления админу:', error);
    }
  }
});

// Обработка кнопок для администратора
bot.hears('📦 Создать заявку', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  // Полный сброс — забываем незавершённую заявку
  orderData.delete(userId);
  orderData.set(userId, { items: [], step: 'warehouse', createdAt: Date.now() });

  try {
    await reloadWarehousesAndProducts();
  } catch (err) {
    console.error('❌ Ошибка загрузки складов:', err.message);
  }

  const warehouses = getWarehouses();

  if (!warehouses || warehouses.length === 0) {
    return ctx.reply(
      '❌ Не удалось загрузить список складов.\n\n' +
      'Возможные причины:\n' +
      '• Нет подключения к базе данных\n' +
      '• Список складов пуст\n\n' +
      'Проверьте настройки базы данных или добавьте склады через панель администратора.'
    );
  }

  const buttons = [];
  for (let i = 0; i < warehouses.length; i += 2) {
    const row = [{ text: warehouses[i], callback_data: `wh_${warehouses[i]}` }];
    if (warehouses[i + 1]) row.push({ text: warehouses[i + 1], callback_data: `wh_${warehouses[i + 1]}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🚫 Отменить', callback_data: 'order_cancel' }]);

  ctx.reply('📦 Создание новой заявки\n\n🏬 Выберите склад:', {
    reply_markup: { inline_keyboard: buttons }
  });
});

// Обработка кнопки "🏬 Склад" - начало создания заявки
bot.hears('🏬 Склад', async (ctx) => {
  const userId = ctx.from.id;
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  if (!isAdminUser && !isClientUser) return;

  // Полный сброс — забываем незавершённую заявку
  orderData.delete(userId);
  orderData.set(userId, { items: [], step: 'warehouse', createdAt: Date.now() });

  try {
    await reloadWarehousesAndProducts();
  } catch (err) {
    console.error('❌ Ошибка загрузки складов:', err.message);
  }

  const warehouses = getWarehouses();

  if (!warehouses || warehouses.length === 0) {
    return ctx.reply(
      '❌ Не удалось загрузить список складов.\n\n' +
      'Список складов пуст или база данных недоступна.\n' +
      'Обратитесь к администратору.'
    );
  }

  const buttons = [];
  for (let i = 0; i < warehouses.length; i += 2) {
    const row = [{ text: warehouses[i], callback_data: `wh_${warehouses[i]}` }];
    if (warehouses[i + 1]) row.push({ text: warehouses[i + 1], callback_data: `wh_${warehouses[i + 1]}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🚫 Отменить', callback_data: 'order_cancel' }]);

  ctx.reply('🏬 Выберите склад:', {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.hears('👨‍💼 Панель администратора', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!admin.isAdmin(userId)) {
    return ctx.reply('❌ У вас нет прав администратора');
  }
  
  const keyboard = [
    [{ text: '👥 Управление клиентами' }],
    [{ text: '📋 Список клиентов' }],
    [{ text: '✏️ Изменить данные клиента' }],
    [{ text: '🚫 Заблокировать клиента' }],
    [{ text: '🔑 Доступ к кассе' }],
    [{ text: '🏬 Управление складами' }],
    [{ text: '🛒 Управление товарами' }],
    [{ text: '💰 Касса' }],
    [{ text: '📊 Отчёт кассы' }],
    [{ text: '📈 Сводный отчёт' }],
    [{ text: '📊 Статистика' }],
    [{ text: '🔙 Назад' }]
  ];
  
  ctx.reply(
    '👨‍💼 Панель администратора\n\n' +
    'Выберите действие:',
    { reply_markup: { keyboard, resize_keyboard: true } }
  );
});

bot.hears('🔙 Назад', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!admin.isAdmin(userId)) {
    return;
  }
  
  const keyboard = [
    [{ text: '📦 Создать заявку' }],
    [{ text: '💰 Касса' }],
    [{ text: '👨‍💼 Панель администратора' }]
  ];
  
  ctx.reply(
    'Главное меню:',
    { reply_markup: { keyboard, resize_keyboard: true } }
  );
});

// ============================================================
// 🔑 ДОСТУП К КАССЕ — выдача/отзыв доступа клиентам
// ============================================================

bot.hears('🔑 Доступ к кассе', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  const clients = await cashAccess.getClientsWithCashAccess();

  let msg = '🔑 Доступ к кассе\n\n';

  if (clients.length > 0) {
    msg += 'Клиенты с доступом:\n';
    clients.forEach((c, i) => {
      msg += `${i + 1}. ${c.name} (${c.phone || 'без тел.'})\n   ID: ${c.telegram_id}\n`;
    });
  } else {
    msg += 'Нет клиентов с доступом к кассе.\n';
  }

  msg += '\n💡 Чтобы дать доступ — найдите клиента через "👥 Управление клиентами" и используйте команду:\n';
  msg += '/grant_cash <ID> — дать доступ\n';
  msg += '/revoke_cash <ID> — забрать доступ\n\n';
  msg += 'Где <ID> — Telegram ID клиента из списка выше.';

  ctx.reply(msg);
});

// ── Мои записи кассы (для клиентов с доступом) ────────────────────────────────
bot.hears('📊 Мои записи кассы', async (ctx) => {
  const userId = ctx.from.id;
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  const hasCash = isAdminUser || (isClientUser && await cashAccess.hasCashAccess(userId));
  
  if (!hasCash) return;

  try {
    // Клиент видит только свои записи, админ — все
    const records = isAdminUser
      ? await database.getCashReport()
      : await cashAccess.getCashReportByCreator(userId);
    const totals = isAdminUser
      ? await database.getCashTotals()
      : await cashAccess.getCashTotalsByCreator(userId);

    let msg = isAdminUser ? '📊 Отчёт кассы\n\n' : '📊 Мои записи кассы\n\n';

    if (records.length === 0) {
      msg += '📭 У вас пока нет записей\n';
    } else {
      records.forEach((r, i) => {
        const date = new Date(r.created_at).toLocaleDateString('ru-RU');
        msg += `${i + 1}. ${r.client_name} (${r.client_phone || '—'})\n`;
        if (r.mode === 'usd' || r.mode === 'both') msg += `   💵 $${parseFloat(r.usd).toLocaleString('ru-RU')}\n`;
        if (r.mode === 'somoni' || r.mode === 'both') msg += `   💴 ${parseFloat(r.somoni).toLocaleString('ru-RU')} сом\n`;
        msg += `   📅 ${date}\n`;
      });
    }

    msg += '\n━━━━━━━━━━━━━━━\n';
    msg += `💵 Итого: $${parseFloat(totals.total_usd || 0).toLocaleString('ru-RU')}\n`;
    msg += `💴 Итого: ${parseFloat(totals.total_somoni || 0).toLocaleString('ru-RU')} сом\n`;
    msg += `📦 Записей: ${totals.count || 0}`;

    const inlineKb = [[{ text: '📤 Передать кассиру', callback_data: 'cash_report_send' }]];
    inlineKb.push([{ text: '📥 Скачать Excel', callback_data: 'cash_report_excel' }, { text: '❌ Закрыть', callback_data: 'cash_report_close' }]);

    await ctx.reply(msg, {
      reply_markup: { inline_keyboard: inlineKb }
    });
  } catch (error) {
    console.error('Ошибка отчёта кассы:', error);
    ctx.reply('❌ Ошибка получения отчёта');
  }
});

bot.command('grant_cash', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('⚠️ Использование: /grant_cash <Telegram ID клиента>');
  }

  const targetId = parseInt(parts[1]);
  if (isNaN(targetId)) {
    return ctx.reply('⚠️ Неверный ID. Использование: /grant_cash <Telegram ID>');
  }

  const granted = await cashAccess.grantCashAccess(targetId);
  if (granted) {
    ctx.reply(`✅ Доступ к кассе выдан для клиента ID: ${targetId}\n\nКлиент увидит кнопку "💰 Касса" после /start`);
  } else {
    ctx.reply(`❌ Клиент с ID ${targetId} не найден. Убедитесь что клиент зарегистрирован и активен.`);
  }
});

bot.command('revoke_cash', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('⚠️ Использование: /revoke_cash <Telegram ID клиента>');
  }

  const targetId = parseInt(parts[1]);
  if (isNaN(targetId)) {
    return ctx.reply('⚠️ Неверный ID. Использование: /revoke_cash <Telegram ID>');
  }

  const revoked = await cashAccess.revokeCashAccess(targetId);
  if (revoked) {
    ctx.reply(`✅ Доступ к кассе забран у клиента ID: ${targetId}`);
  } else {
    ctx.reply(`❌ Клиент с ID ${targetId} не найден.`);
  }
});

// ============================================================
// 💰 КАССА — инкассо кассиру через WhatsApp
// ============================================================

bot.hears('💰 Касса', async (ctx) => {
  const userId = ctx.from.id;
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  const hasCash = isAdminUser || (isClientUser && await cashAccess.hasCashAccess(userId));
  
  if (!hasCash) return;

  // И админ и клиент с доступом — ищут клиента
  orderData.set(userId, { step: 'cash_search', createdAt: Date.now() });
  ctx.reply(
    '💰 Касса — Инкасса\n\n🔍 Введите имя или телефон клиента:',
    { reply_markup: { remove_keyboard: true } }
  );
});

bot.hears('📈 Сводный отчёт', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  await ctx.reply(
    '📈 Сводный отчёт кассы\n\nВыберите период:',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '7 дней', callback_data: 'summary_7' }, { text: '14 дней', callback_data: 'summary_14' }],
          [{ text: '30 дней', callback_data: 'summary_30' }, { text: 'Весь период', callback_data: 'summary_0' }]
        ]
      }
    }
  );
});

bot.hears('📊 Отчёт кассы', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  try {
    const lastSent = await database.getLastCashReportSent();
    const records = await database.getCashReport();
    const totals = await database.getCashTotals();

    const fromDate = lastSent ? new Date(lastSent).toLocaleDateString('ru-RU') : 'начала';
    const toDate = new Date().toLocaleDateString('ru-RU');

    let msg = '📊 Отчёт кассы\n📅 ' + fromDate + ' — ' + toDate + '\n\n';

    if (records.length === 0) {
      msg += '📭 Новых записей нет\n';
    } else {
      records.forEach((r, i) => {
        const date = new Date(r.created_at).toLocaleDateString('ru-RU');
        msg += (i + 1) + '. ' + r.client_name + ' (' + (r.client_phone || '—') + ')\n';
        if (r.mode === 'usd' || r.mode === 'both') msg += '   💵 $' + parseFloat(r.usd).toLocaleString('ru-RU') + '\n';
        if (r.mode === 'somoni' || r.mode === 'both') msg += '   💴 ' + parseFloat(r.somoni).toLocaleString('ru-RU') + ' сом\n';
        msg += '   📅 ' + date + '\n';
      });
    }

    msg += '\n━━━━━━━━━━━━━━━\n';
    msg += '💵 Итого: *$' + parseFloat(totals.total_usd).toLocaleString('ru-RU') + '*\n';
    msg += '💴 Итого: *' + parseFloat(totals.total_somoni).toLocaleString('ru-RU') + ' сом*\n';
    msg += '📦 Записей: ' + totals.count;

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📤 Передать кассиру', callback_data: 'cash_report_send' }
        ],
        [
          { text: '📥 Скачать Excel', callback_data: 'cash_report_excel' },
          { text: '❌ Закрыть', callback_data: 'cash_report_close' }
        ]]
      }
    });
  } catch (error) {
    console.error('Ошибка отчёта кассы:', error);
    ctx.reply('❌ Ошибка получения отчёта');
  }
});


// Вспомогательная функция: формирует и показывает шаблон инкассо
async function buildCashMessage(ctx, userId, data) {
  const client = data.cashClient;
  const lines = [
    '💰 ИНКАССА',
    '',
    '👤 Клиент: ' + client.name,
    '📞 Телефон: ' + (client.phone || 'не указан')
  ];

  if (data.cashMode === 'usd') {
    lines.push('💵 Доллар: *$' + data.cashUsd.toLocaleString('ru-RU') + '*');
  }

  if (data.cashMode === 'somoni') {
    lines.push('💴 Сомони: *' + data.cashSomoni.toLocaleString('ru-RU') + ' сом*');
    lines.push('📈 Курс: *' + data.cashRate.toLocaleString('ru-RU') + '*');
    const equiv = (data.cashSomoni / data.cashRate).toFixed(2);
    lines.push('💵 Эквивалент: *$' + parseFloat(equiv).toLocaleString('ru-RU') + '*');
  }

  if (data.cashMode === 'both') {
    lines.push('💵 Доллар: *$' + data.cashUsd.toLocaleString('ru-RU') + '*');
    lines.push('💴 Сомони: *' + data.cashSomoni.toLocaleString('ru-RU') + ' сом*');
    lines.push('📈 Курс: *' + data.cashRate.toLocaleString('ru-RU') + '*');
  }

  lines.push('📅 ' + new Date().toLocaleDateString('ru-RU'));

  if (data.cashComment) {
    lines.push('💬 Комментарий: ' + data.cashComment);
  }

  const cashMessage = lines.join('\n');
  data.cashMessage = cashMessage;
  data.step = 'cash_confirm';
  orderData.set(userId, data);

  const cashierPhone = process.env.CASHIER_WHATSAPP_PHONE || process.env.WHATSAPP_RECIPIENT;

  return ctx.reply(
    '📋 Шаблон сообщения кассиру:\n\n' + cashMessage + '\n\n' +
    '📱 Кассир: ' + (cashierPhone || '❌ не настроен') + '\n\nОтправить?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Отправить кассиру', callback_data: 'cash_send' },
          { text: '❌ Отмена', callback_data: 'cash_cancel' }
        ]]
      }
    }
  );
}

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  
  // Игнорируем команды (они обрабатываются отдельно)
  if (text.startsWith('/')) {
    return;
  }
  
  // Проверка прав доступа
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  
  if (!isAdminUser && !isClientUser) {
    return; // Игнорируем сообщения от неавторизованных пользователей
  }
  
  const data = orderData.get(userId) || { items: [], step: 'name' };

  try {
    // ── Касса: поиск клиента (админ и клиент с доступом) ──
    if (data.step === 'cash_search' && (isAdminUser || await cashAccess.hasCashAccess(userId))) {
      const query = text.trim().toLowerCase();
      if (query.length < 2) {
        return ctx.reply('⚠️ Введите минимум 2 символа');
      }
      const allClients = await database.getAllClients();
      const found = allClients.filter(c =>
        (c.name || '').toLowerCase().includes(query) ||
        (c.phone || '').toLowerCase().includes(query)
      ).slice(0, 10);

      if (found.length === 0) {
        return ctx.reply(`❌ Клиент не найден: "${text}"\n\nПопробуйте ещё раз:`);
      }

      data.step = 'cash_select_client';
      data.cashFoundClients = found;
      orderData.set(userId, data);

      const inlineKeyboard = found.map(c => [{
        text: `${c.name} (${c.phone || 'без тел.'})`,
        callback_data: `cash_client_${c.telegram_id}`
      }]);

      return ctx.reply('👤 Выберите клиента:', {
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }

    // ── Касса: ввод суммы (доллар) ──
    if (data.step === 'cash_enter_usd' && data.cashClient) {
      const amount = text.trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('⚠️ Введите сумму числом (например: 500)');
      }
      data.cashUsd = parseFloat(amount);
      if (data.cashMode === 'usd') {
        data.step = 'cash_enter_comment';
        orderData.set(userId, data);
        return ctx.reply('💬 Введите комментарий (или нажмите /skip чтобы пропустить):');
      }
      data.step = 'cash_enter_somoni';
      orderData.set(userId, data);
      return ctx.reply(`💵 Доллар: $${data.cashUsd.toLocaleString('ru-RU')}\n\n💴 Введите сумму в сомони:`);
    }

    // ── Касса: ввод суммы (сомони) ──
    if (data.step === 'cash_enter_somoni' && data.cashClient) {
      const amount = text.trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('⚠️ Введите сумму числом (например: 5000)');
      }
      data.cashSomoni = parseFloat(amount);
      data.step = 'cash_enter_rate';
      orderData.set(userId, data);
      return ctx.reply(`💴 Сомони: ${data.cashSomoni.toLocaleString('ru-RU')} сом\n\n📈 Введите курс доллара (сомони за $1):`);
    }

    // ── Касса: ввод курса (после сомони) ──
    if (data.step === 'cash_enter_rate' && data.cashClient) {
      const rate = text.trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(rate)) {
        return ctx.reply('⚠️ Введите курс числом (например: 10900)');
      }
      data.cashRate = parseFloat(rate);
      data.step = 'cash_enter_comment';
      orderData.set(userId, data);
      return ctx.reply('💬 Введите комментарий (или нажмите /skip чтобы пропустить):');
    }

    // ── Касса: ввод комментария ──
    if (data.step === 'cash_enter_comment' && data.cashClient) {
      data.cashComment = text.trim() === '/skip' ? '' : text.trim();
      return buildCashMessage(ctx, userId, data);
    }
    // Обработка поиска клиента (только для администраторов)
    if (data.step === 'search_client' && isAdminUser) {
      const searchQuery = text.trim().toLowerCase();
      
      if (searchQuery.length < 2) {
        return ctx.reply('⚠️ Введите минимум 2 символа для поиска');
      }
      
      try {
        // Всегда загружаем свежий список из БД
        const allClients = await database.getAllClients();
        
        if (allClients.length === 0) {
          return ctx.reply('❌ В системе нет зарегистрированных клиентов.\nСначала добавьте клиентов через панель администратора.');
        }
        
        // Фильтруем клиентов по поисковому запросу
        const foundClients = allClients.filter(client => {
          const clientName = (client.name || '').toLowerCase();
          const clientPhone = (client.phone || '').toLowerCase();
          return clientName.includes(searchQuery) || clientPhone.includes(searchQuery);
        });
        
        if (foundClients.length === 0) {
          return ctx.reply(
            `❌ Клиенты не найдены по запросу: "${text}"\n\n` +
            'Попробуйте ввести другое имя или часть имени:'
          );
        }
        
        // Ограничиваем количество результатов до 10
        const limitedClients = foundClients.slice(0, 10);
        
        // Создаем inline-клавиатуру с найденными клиентами
        const inlineKeyboard = limitedClients.map(client => [{
          text: `${client.name || 'Без имени'} (${client.phone || 'Без телефона'})`,
          callback_data: `select_client_${client.telegram_id}`
        }]);
        
        // Сохраняем список найденных клиентов (свежий из БД)
        data.step = 'select_client';
        data.clientsList = limitedClients;
        orderData.set(userId, data);
        
        let message = `🔍 Найдено клиентов: ${foundClients.length}`;
        if (foundClients.length > 10) {
          message += ` (показаны первые 10)`;
        }
        message += '\n\n👤 Выберите клиента:';
        
        return ctx.reply(message, {
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
      } catch (error) {
        console.error('Ошибка поиска клиентов:', error);
        return ctx.reply('❌ Ошибка при поиске клиентов');
      }
    }
    
    // Обработка редактирования профиля
    if (data.editingProfile === 'name') {
      const newName = text.trim();
      
      try {
        const client = await database.getClient(userId);
        await database.updateClient(userId, newName, client.phone);
        
        delete data.editingProfile;
        orderData.delete(userId);
        
        const keyboard = isAdminUser 
          ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
          : [[{ text: '🏬 Склад' }]];
        
        return ctx.reply(
          `✅ Имя успешно изменено на: ${newName}`,
          { reply_markup: { keyboard, resize_keyboard: true } }
        );
      } catch (error) {
        console.error('Ошибка обновления имени:', error);
        return ctx.reply('❌ Ошибка при обновлении имени');
      }
    }
    
    if (data.editingProfile === 'phone') {
      const newPhone = text.trim();
      
      try {
        const client = await database.getClient(userId);
        await database.updateClient(userId, client.name, newPhone);
        
        delete data.editingProfile;
        orderData.delete(userId);
        
        const keyboard = isAdminUser 
          ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
          : [[{ text: '🏬 Склад' }]];
        
        return ctx.reply(
          `✅ Телефон успешно изменен на: ${newPhone}`,
          { reply_markup: { keyboard, resize_keyboard: true } }
        );
      } catch (error) {
        console.error('Ошибка обновления телефона:', error);
        return ctx.reply('❌ Ошибка при обновлении телефона');
      }
    }
    
    // Шаг 1: Выбор склада
    if (data.step === 'warehouse' && getWarehouses().includes(text)) {
      data.warehouse = text;
      data.step = 'product';
      orderData.set(userId, data);
      
      // 🔄 Обновляем товары из БД перед показом
      console.log('🔄 Обновление списка товаров из БД...');
      await loadWarehousesAndProducts();
      
      const keyboard = getProducts().map(p => [{ text: p }]);
      
      return ctx.reply(
        `✅ Склад: ${text}\n\n🛒 Выберите товар:`,
        { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } }
      );
    }

    // Шаг 2: Выбор товара
    if (data.step === 'product' && getProducts().includes(text)) {
      data.currentProduct = text;
      data.step = 'quantity';
      orderData.set(userId, data);
      
      return ctx.reply(
        `📦 Товар: ${text}\n\n` +
        'Введите количество (только число):\n(например: 200)',
        { reply_markup: { remove_keyboard: true } }
      );
    }

    // Шаг 3: Количество товара
    if (data.step === 'quantity') {
      const quantity = text.trim();
      
      // Блокируем тексты кнопок
      const forbidden = ['✅ Продолжить', '➕ Добавить еще товар', '✅ Подтвердить', '❌ Отменить', '🏬 Склад', '📦 Создать заявку', '🚫 Отменить заявку'];
      if (forbidden.includes(text)) {
        return ctx.reply('⚠️ Введите количество числом (например: 200)');
      }

      data.items = data.items || [];
      data.items.push({ product: data.currentProduct, quantity: quantity + ' шт' });
      delete data.currentProduct;
      data.step = 'add_more';
      orderData.set(userId, data);

      let message = '✅ Товар добавлен!\n\n';
      message += `🏬 Склад: ${data.warehouse}\n\nТовары:\n`;
      data.items.forEach((item, i) => { message += `${i + 1}. ${item.product} — ${item.quantity}\n`; });
      message += '\nЧто дальше?';

      return ctx.reply(message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Добавить ещё товар', callback_data: 'order_add_more' }],
            [{ text: '✅ Продолжить', callback_data: 'order_continue' }],
            [{ text: '🚫 Отменить', callback_data: 'order_cancel' }]
          ]
        }
      });
    }

    // Шаг 4: add_more теперь обрабатывается через inline кнопки (order_add_more, order_continue)

    // Шаг 5: Имя (если первый раз или обновление)
    if (data.step === 'name') {
      let finalName = text;
      
      // Если пользователь отправил "-", используем существующее имя
      if (text === '-') {
        const client = await database.getClient(userId);
        if (client && client.name && client.name.trim() !== '') {
          finalName = client.name;
        } else {
          return ctx.reply('❌ У вас нет сохраненного имени. Введите ваше имя:');
        }
      }
      
      data.name = finalName;
      data.step = 'phone';
      orderData.set(userId, data);
      
      // Проверяем, есть ли сохраненный телефон
      const client = await database.getClient(userId);
      if (client && client.phone && client.phone.trim() !== '') {
        return ctx.reply(
          `📞 Ваш текущий телефон: ${client.phone}\n\n` +
          'Введите новый номер телефона или отправьте "-" чтобы оставить текущий:\n' +
          '(например: +992900000000)'
        );
      } else {
        return ctx.reply('📞 Введите ваш номер телефона:\n(например: +992900000000)');
      }
    }

    // Шаг 6: Телефон (если первый раз или обновление)
    if (data.step === 'phone') {
      let finalPhone = text;
      
      // Если пользователь отправил "-", используем существующий телефон
      if (text === '-') {
        const client = await database.getClient(userId);
        if (client && client.phone && client.phone.trim() !== '') {
          finalPhone = client.phone;
        } else {
          return ctx.reply('❌ У вас нет сохраненного телефона. Введите ваш номер телефона:');
        }
      }
      
      data.phone = finalPhone;
      data.step = 'transport';
      orderData.set(userId, data);
      
      // Сохраняем имя и телефон в базу данных
      try {
        await database.updateClient(userId, data.name, data.phone);
        console.log(`✅ Обновлены данные клиента ${userId}: ${data.name}, ${data.phone}`);
      } catch (error) {
        console.error('Ошибка сохранения данных клиента:', error);
      }
      
      return ctx.reply('🚚 Введите номер транспорта:\n(например: 1234 AB)');
    }

    // Шаг 7: Номер транспорта
    if (data.step === 'transport') {
      if (text === '🚫 Отменить заявку') {
        orderData.delete(userId);
        const kb = isAdminUser
          ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
          : [[{ text: '🏬 Склад' }]];
        return ctx.reply('❌ Заявка отменена.', { reply_markup: { keyboard: kb, resize_keyboard: true } });
      }
      data.transport = text;
      data.step = 'comment';
      orderData.set(userId, data);
      return ctx.reply(
        '📝 Введите комментарий или отправьте "-" чтобы пропустить:',
        { reply_markup: { keyboard: [[{ text: '🚫 Отменить заявку' }]], resize_keyboard: true } }
      );
    }

    // Шаг 8: Комментарий
    if (data.step === 'comment') {
      if (text === '🚫 Отменить заявку') {
        orderData.delete(userId);
        const kb = isAdminUser
          ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
          : [[{ text: '🏬 Склад' }]];
        return ctx.reply('❌ Заявка отменена.', { reply_markup: { keyboard: kb, resize_keyboard: true } });
      }
      data.comment = text === '-' ? '' : text;
      data.step = 'confirm';
      orderData.set(userId, data);
      
      const preview = formatOrder(data);
      const keyboard = [
        [{ text: '✅ Подтвердить' }],
        [{ text: '❌ Отменить' }]
      ];
      
      return ctx.reply(
        '📋 Проверьте заявку:\n\n' + preview + '\n\nВсе верно?',
        { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } }
      );
    }

    // Подтверждение заявки
    if (text === '✅ Подтвердить') {
      const orderMessage = formatOrder(data);
      
      // Сохранение в БД
      try {
        // Если администратор создает заявку для клиента, используем telegram_id клиента
        const clientTelegramId = data.selectedClient ? data.selectedClient.telegram_id : userId;
        const user = await database.getOrCreateUser(clientTelegramId, data.name, data.phone);
        const orderId = await database.createOrder(
          user.id,
          data.warehouse,
          data.transport,
          data.comment
        );
        
        for (const item of data.items) {
          await database.addOrderItem(orderId, item.product, item.quantity);
        }
        
        ctx.reply('💾 Заявка сохранена в базе данных');
      } catch (error) {
        console.error('Ошибка сохранения в БД:', error);
      }

      // Отправка в Telegram группу
      const groupId = process.env.TELEGRAM_GROUP_ID;
      let telegramSent = false;
      
      if (groupId) {
        try {
          await bot.telegram.sendMessage(groupId, orderMessage);
          console.log('✅ Заявка отправлена в Telegram группу');
          telegramSent = true;
        } catch (error) {
          console.error('❌ Ошибка отправки в Telegram группу:', error.message);
        }
      }

      // 🎯 УМНАЯ МАРШРУТИЗАЦИЯ WhatsApp по складам
      let whatsappSent = false;
      
      try {
        console.log(`🔍 Проверка маршрутизации для склада: "${data.warehouse}"`);
        
        // Получаем настройки WhatsApp для выбранного склада (группа, номер и Green-API)
        let warehouseWhatsAppSettings = null;
        try {
          warehouseWhatsAppSettings = await database.getWarehouseWhatsAppSettings(data.warehouse);
        } catch (error) {
          console.log(`⚠️ Ошибка получения настроек WhatsApp: ${error.message}`);
        }
        
        const warehouseWhatsAppGroup = warehouseWhatsAppSettings?.whatsapp_group_id;
        const warehouseWhatsAppPhone = warehouseWhatsAppSettings?.whatsapp_phone;
        const warehouseGreenApiInstance = warehouseWhatsAppSettings?.green_api_instance_id;
        const warehouseGreenApiToken = warehouseWhatsAppSettings?.green_api_token;
        
        console.log(`📱 WhatsApp группа для склада "${data.warehouse}": ${warehouseWhatsAppGroup || 'не найдена'}`);
        console.log(`📱 WhatsApp номер для склада "${data.warehouse}": ${warehouseWhatsAppPhone || 'не указан'}`);
        console.log(`🔑 Green-API инстанс для склада "${data.warehouse}": ${warehouseGreenApiInstance || 'не настроен (используется общий)'}`);
        
        // Приоритет 1: Личный номер склада
        if (warehouseWhatsAppPhone) {
          console.log(`📤 Отправка заявки на личный WhatsApp номер склада "${data.warehouse}": ${warehouseWhatsAppPhone}`);
          whatsappSent = await whatsapp.sendMessage(
            orderMessage, 
            warehouseWhatsAppPhone,
            warehouseGreenApiInstance,
            warehouseGreenApiToken
          );
          
          if (whatsappSent) {
            console.log(`✅ Заявка отправлена на личный WhatsApp номер склада "${data.warehouse}"`);
          } else {
            console.log(`❌ Ошибка отправки на личный номер склада "${data.warehouse}"`);
          }
        }
        // Приоритет 2: Группа склада
        else if (warehouseWhatsAppGroup) {
          console.log(`📤 Отправка заявки в WhatsApp группу склада "${data.warehouse}": ${warehouseWhatsAppGroup}`);
          whatsappSent = await whatsapp.sendToGroup(
            orderMessage, 
            warehouseWhatsAppGroup,
            warehouseGreenApiInstance,
            warehouseGreenApiToken
          );
          
          if (whatsappSent) {
            console.log(`✅ Заявка отправлена в WhatsApp группу склада "${data.warehouse}"`);
          } else {
            console.log(`❌ Ошибка отправки в группу склада "${data.warehouse}"`);
          }
        }
        // Приоритет 3: Общие настройки
        else {
          console.log(`⚠️ У склада "${data.warehouse}" нет привязанных WhatsApp настроек, используем общие`);
          
          const whatsappGroupId = process.env.WHATSAPP_GROUP_ID;
          const whatsappRecipient = process.env.WHATSAPP_RECIPIENT;
          
          console.log(`📋 Общая группа: ${whatsappGroupId || 'не настроена'}`);
          console.log(`📋 Общий получатель: ${whatsappRecipient || 'не настроен'}`);
          
          if (whatsappGroupId) {
            // Отправка в общую WhatsApp группу
            console.log(`📤 Отправка в общую WhatsApp группу: ${whatsappGroupId}`);
            whatsappSent = await whatsapp.sendToGroup(orderMessage, whatsappGroupId);
          } else if (whatsappRecipient) {
            // Отправка общему личному получателю
            console.log(`📤 Отправка общему личному получателю: ${whatsappRecipient}`);
            whatsappSent = await whatsapp.sendMessage(orderMessage, whatsappRecipient);
          }
        }
      } catch (error) {
        console.error('❌ Ошибка отправки в WhatsApp:', error);
      }
      
      // Уведомление пользователя
      let statusMessage = '';
      if (telegramSent && whatsappSent) {
        statusMessage = `✅ Заявка отправлена в Telegram и WhatsApp группу склада "${data.warehouse}"!`;
      } else if (telegramSent) {
        statusMessage = '✅ Заявка отправлена в Telegram группу!';
      } else if (whatsappSent) {
        statusMessage = `✅ Заявка отправлена в WhatsApp группу склада "${data.warehouse}"!`;
      } else {
        statusMessage = '⚠️ Заявка сохранена в базе данных';
      }
      
      ctx.reply(statusMessage, {
        reply_markup: { remove_keyboard: true }
      });

      // Очистка данных
      orderData.delete(userId);
      
      // Возвращаем меню
      const isAdminUser = admin.isAdmin(userId);
      
      if (isAdminUser) {
        const keyboard = [
          [{ text: '📦 Создать заявку' }],
          [{ text: '💰 Касса' }],
          [{ text: '👨‍💼 Панель администратора' }]
        ];
        
        setTimeout(() => {
          ctx.reply('Главное меню:', {
            reply_markup: { keyboard, resize_keyboard: true }
          });
        }, 2000);
      } else {
        const keyboard = [
          [{ text: '🏬 Склад' }]
        ];
        
        setTimeout(() => {
          ctx.reply('Создать новую заявку? Нажмите "🏬 Склад"', {
            reply_markup: { keyboard, resize_keyboard: true }
          });
        }, 2000);
      }
    }

    // Отмена заявки
    if (text === '❌ Отменить') {
      orderData.delete(userId);
      const isAdminUser2 = admin.isAdmin(userId);
      const keyboard = isAdminUser2
        ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
        : [[{ text: '🏬 Склад' }]];
      ctx.reply('❌ Заявка отменена.', { reply_markup: { keyboard, resize_keyboard: true } });
    }

  } catch (error) {
    console.error('Ошибка обработки:', error);
    ctx.reply('❌ Произошла ошибка. Попробуйте снова /start');
    orderData.delete(userId);
  }
});

// Обработка inline-кнопок (callback_query)
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const callbackData = ctx.callbackQuery.data;
  
  // Проверка прав доступа
  const isAdminUser = admin.isAdmin(userId);
  
  // Для обычных клиентов разрешаем только их собственные callback (approve/reject не нужны)
  // Блокируем только admin-specific действия
  const adminOnlyCallbacks = ['select_client_', 'cash_client_', 'cash_mode_', 'cash_send', 'cash_cancel',
    'cash_report_close', 'cash_report_excel', 'cash_report_send', 'summary_'];
  const isAdminCallback = adminOnlyCallbacks.some(prefix => callbackData.startsWith(prefix));
  
  if (!isAdminUser && isAdminCallback) {
    return ctx.answerCbQuery('❌ У вас нет прав для этого действия');
  }
  
  try {
    // ── Отмена заявки через inline ──
    if (callbackData === 'order_cancel') {
      orderData.delete(userId);
      await ctx.answerCbQuery('Отменено');
      await ctx.editMessageText('❌ Заявка отменена.');
      const kb = isAdminUser
        ? [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]]
        : [[{ text: '🏬 Склад' }]];
      return ctx.reply('Главное меню:', { reply_markup: { keyboard: kb, resize_keyboard: true } });
    }

    // ── Выбор склада ──
    if (callbackData.startsWith('wh_')) {
      const warehouse = callbackData.replace('wh_', '');
      const data = orderData.get(userId) || { items: [], createdAt: Date.now() };
      data.warehouse = warehouse;
      data.step = 'product';
      orderData.set(userId, data);
      await ctx.answerCbQuery(`✅ ${warehouse}`);

      try {
        await reloadWarehousesAndProducts();
      } catch (err) {
        console.error('❌ Ошибка загрузки товаров:', err.message);
      }

      const products = getProducts();

      if (!products || products.length === 0) {
        orderData.delete(userId);
        return ctx.editMessageText(
          '❌ Не удалось загрузить список товаров.\n\n' +
          'Возможные причины:\n' +
          '• Нет подключения к базе данных\n' +
          '• Список товаров пуст\n\n' +
          'Обратитесь к администратору или попробуйте позже.',
          { reply_markup: { inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: `wh_${warehouse}` }], [{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } }
        );
      }

      const buttons = [];
      for (let i = 0; i < products.length; i += 2) {
        const row = [{ text: products[i], callback_data: `pr_${products[i]}` }];
        if (products[i + 1]) row.push({ text: products[i + 1], callback_data: `pr_${products[i + 1]}` });
        buttons.push(row);
      }
      buttons.push([{ text: '🚫 Отменить', callback_data: 'order_cancel' }]);

      return ctx.editMessageText(`✅ Склад: ${warehouse}\n\n🛒 Выберите товар:`, {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    // ── Выбор товара ──
    if (callbackData.startsWith('pr_')) {
      const product = callbackData.replace('pr_', '');
      const data = orderData.get(userId);
      if (!data) return ctx.answerCbQuery('❌ Сессия устарела, начните заново');
      data.currentProduct = product;
      data.step = 'quantity';
      orderData.set(userId, data);
      await ctx.answerCbQuery(`✅ ${product}`);
      return ctx.editMessageText(
        `✅ Склад: ${data.warehouse}\n📦 Товар: ${product}\n\n✏️ Введите количество (только число):`,
        { reply_markup: { inline_keyboard: [[{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } }
      );
    }

    // ── Добавить ещё товар или продолжить (inline) ──
    if (callbackData === 'order_add_more') {
      const data = orderData.get(userId);
      if (!data) return ctx.answerCbQuery('❌ Сессия устарела');
      data.step = 'product';
      orderData.set(userId, data);
      await ctx.answerCbQuery();

      try {
        await reloadWarehousesAndProducts();
      } catch (err) {
        console.error('❌ Ошибка загрузки товаров:', err.message);
      }

      const products = getProducts();

      if (!products || products.length === 0) {
        return ctx.editMessageText(
          '❌ Не удалось загрузить список товаров. Обратитесь к администратору.',
          { reply_markup: { inline_keyboard: [[{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } }
        );
      }

      const buttons = [];
      for (let i = 0; i < products.length; i += 2) {
        const row = [{ text: products[i], callback_data: `pr_${products[i]}` }];
        if (products[i + 1]) row.push({ text: products[i + 1], callback_data: `pr_${products[i + 1]}` });
        buttons.push(row);
      }
      buttons.push([{ text: '🚫 Отменить', callback_data: 'order_cancel' }]);

      return ctx.editMessageText('🛒 Выберите товар:', {
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (callbackData === 'order_continue') {
      const data = orderData.get(userId);
      if (!data) return ctx.answerCbQuery('❌ Сессия устарела');
      await ctx.answerCbQuery();

      if (isAdminUser) {
        data.step = 'search_client';
        orderData.set(userId, data);
        let summary = '📋 Заявка:\n\n';
        summary += `🏬 Склад: ${data.warehouse}\n\nТовары:\n`;
        data.items.forEach((item, i) => { summary += `${i + 1}. ${item.product} — ${item.quantity}\n`; });
        summary += '\n🔍 Введите имя клиента для поиска:';
        return ctx.editMessageText(summary, { reply_markup: { inline_keyboard: [[{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } });
      }

      // Обычный клиент
      const client = await database.getClient(userId);
      if (client && client.name && client.phone && client.name.trim() !== '' && client.phone.trim() !== '') {
        data.name = client.name;
        data.phone = client.phone;
        data.step = 'transport';
        orderData.set(userId, data);
        let summary = '📋 Ваша заявка:\n\n';
        summary += `👤 ${client.name}\n📞 ${client.phone}\n🏬 ${data.warehouse}\n\nТовары:\n`;
        data.items.forEach((item, i) => { summary += `${i + 1}. ${item.product} — ${item.quantity}\n`; });
        summary += '\n🚚 Введите номер транспорта:';
        return ctx.editMessageText(summary, { reply_markup: { inline_keyboard: [[{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } });
      } else {
        data.step = 'name';
        orderData.set(userId, data);
        return ctx.editMessageText('📝 Введите ваше имя:', { reply_markup: { inline_keyboard: [[{ text: '🚫 Отменить', callback_data: 'order_cancel' }]] } });
      }
    }

    // Обработка выбора клиента
    if (callbackData.startsWith('select_client_')) {
      const clientTelegramId = callbackData.replace('select_client_', '');
      const data = orderData.get(userId);
      
      console.log('🔍 Поиск клиента с telegram_id:', clientTelegramId);
      
      if (!data || data.step !== 'select_client' || !data.clientsList) {
        console.log('❌ Данные заявки не найдены');
        return ctx.answerCbQuery('❌ Ошибка: данные заявки не найдены');
      }
      
      console.log('📋 Список клиентов:', data.clientsList.map(c => ({ id: c.telegram_id, name: c.name })));
      
      // Ищем выбранного клиента в списке (сравниваем как строки)
      const selectedClient = data.clientsList.find(client => 
        String(client.telegram_id) === String(clientTelegramId)
      );
      
      if (!selectedClient) {
        console.log('❌ Клиент не найден в списке');
        return ctx.answerCbQuery('❌ Клиент не найден');
      }
      
      console.log('✅ Клиент найден:', selectedClient.name);
      
      // Сохраняем данные выбранного клиента
      data.selectedClient = selectedClient;
      data.name = selectedClient.name;
      data.phone = selectedClient.phone;
      data.step = 'transport';
      orderData.set(userId, data);
      
      // Отвечаем на callback
      await ctx.answerCbQuery(`✅ Выбран клиент: ${selectedClient.name}`);
      
      // Редактируем сообщение, убирая кнопки
      let summary = '📋 Ваша заявка:\n\n';
      summary += `👤 Клиент: ${selectedClient.name}\n`;
      summary += `📞 Телефон: ${selectedClient.phone}\n`;
      summary += `🏬 Склад: ${data.warehouse}\n\n`;
      summary += 'Товары:\n';
      data.items.forEach((item, i) => {
        summary += `${i + 1}. ${item.product} — ${item.quantity}\n`;
      });
      
      await ctx.editMessageText(summary);
      
      // Отправляем новое сообщение с запросом номера транспорта
      await ctx.reply('🚚 Введите номер транспорта:\n(например: 1234 AB)', {
        reply_markup: { remove_keyboard: true }
      });
    }

    // ── Касса: выбор клиента ──
    if (callbackData.startsWith('cash_client_')) {
      const clientTelegramId = callbackData.replace('cash_client_', '');
      const allClients = await database.getAllClients();
      const client = allClients.find(c => String(c.telegram_id) === String(clientTelegramId));

      if (!client) return ctx.answerCbQuery('❌ Клиент не найден');

      orderData.set(userId, {
        step: 'cash_select_mode',
        cashClient: client,
        createdAt: Date.now()
      });

      await ctx.answerCbQuery(`✅ ${client.name}`);
      await ctx.editMessageText(
        `💰 Касса — Инкассо\n\n` +
        `👤 Клиент: ${client.name}\n` +
        `📞 Телефон: ${client.phone || 'не указан'}\n\n` +
        `💱 Какую валюту принёс клиент?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💵 Доллар', callback_data: 'cash_mode_usd' }],
              [{ text: '💴 Сомони', callback_data: 'cash_mode_somoni' }],
              [{ text: '💵+💴 Обе валюты', callback_data: 'cash_mode_both' }],
              [{ text: '❌ Отмена', callback_data: 'cash_cancel' }]
            ]
          }
        }
      );
    }

    // ── Касса: выбор режима валюты ──
    if (callbackData.startsWith('cash_mode_')) {
      const mode = callbackData.replace('cash_mode_', ''); // usd | somoni | both
      const data = orderData.get(userId);
      if (!data) return ctx.answerCbQuery('❌ Данные устарели');

      data.cashMode = mode;
      orderData.set(userId, data);

      if (mode === 'usd' || mode === 'both') {
        data.step = 'cash_enter_usd';
        orderData.set(userId, data);
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `👤 ${data.cashClient.name}\n\n💵 Введите сумму в долларах:`
        );
      } else {
        // только сомони
        data.step = 'cash_enter_somoni';
        orderData.set(userId, data);
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `👤 ${data.cashClient.name}\n\n💴 Введите сумму в сомони:`
        );
      }
    }

    // ── Касса: подтверждение отправки ──
    if (callbackData === 'cash_send') {
      const data = orderData.get(userId);
      if (!data || data.step !== 'cash_confirm') return ctx.answerCbQuery('❌ Данные устарели');

      const cashierPhone = process.env.CASHIER_WHATSAPP_PHONE || process.env.WHATSAPP_RECIPIENT;
      if (!cashierPhone) {
        await ctx.answerCbQuery('❌ Номер кассира не настроен');
        return ctx.reply('❌ Добавьте переменную CASHIER_WHATSAPP_PHONE в Railway');
      }

      const cashierInstanceId = process.env.GREEN_API_INSTANCE_ID_PERSONAL || process.env.GREEN_API_INSTANCE_ID;
      const cashierToken = process.env.GREEN_API_TOKEN_PERSONAL || process.env.GREEN_API_TOKEN;
      const sent = await whatsapp.sendMessage(data.cashMessage, cashierPhone, cashierInstanceId, cashierToken);

      // Сохраняем запись в БД
      await database.addCashRecord(
        data.cashClient?.telegram_id,
        data.cashClient?.name,
        data.cashClient?.phone,
        data.cashMode,
        data.cashUsd || 0,
        data.cashSomoni || 0,
        data.cashRate || 0,
        userId,
        data.cashComment || ''
      );
      await ctx.answerCbQuery(sent ? '✅ Отправлено!' : '❌ Ошибка отправки');
      await ctx.editMessageText(
        sent
          ? `✅ Сообщение отправлено кассиру!\n\n${data.cashMessage}`
          : `❌ Ошибка отправки в WhatsApp. Сообщение:\n\n${data.cashMessage}`
      );

      orderData.delete(userId);

      setTimeout(() => {
        ctx.reply('Главное меню:', {
          reply_markup: {
            keyboard: [[{ text: '📦 Создать заявку' }], [{ text: '💰 Касса' }], [{ text: '👨‍💼 Панель администратора' }]],
            resize_keyboard: true
          }
        });
      }, 1500);
    }

    if (callbackData === 'cash_cancel') {
      orderData.delete(userId);
      await ctx.answerCbQuery('Отменено');
      await ctx.editMessageText('❌ Инкассо отменено');
    }

    if (callbackData === 'cash_report_close') {
      await ctx.answerCbQuery('Закрыто');
      await ctx.editMessageText('📊 Отчёт закрыт');
    }

    if (callbackData === 'cash_report_excel') {
      try {
        await ctx.answerCbQuery('⏳ Генерирую Excel...');
        const excelExporter = require('./excel-export');
        const excelResult = await excelExporter.exportCashReport();
        if (excelResult.success) {
          const lastSent = await database.getLastCashReportSent();
          const fromDate = lastSent ? new Date(lastSent).toLocaleDateString('ru-RU') : 'начала';
          const toDate = new Date().toLocaleDateString('ru-RU');
          await ctx.replyWithDocument(
            { source: excelResult.filePath, filename: excelResult.fileName },
            { caption: '📊 Отчёт кассы: ' + fromDate + ' — ' + toDate }
          );
        } else {
          await ctx.reply('❌ Ошибка генерации Excel');
        }
      } catch (error) {
        console.error('Ошибка Excel отчёта:', error);
        await ctx.reply('❌ Ошибка: ' + error.message);
      }
    }

    // Сводный отчёт по периоду
    if (callbackData && callbackData.startsWith('summary_')) {
      try {
        const days = parseInt(callbackData.split('_')[1]);
        const label = days === 0 ? 'весь период' : days + ' дней';

        await ctx.answerCbQuery('⏳ Формирую отчёт...');

        const summary = await database.getCashSummary(days || null);
        const { totals, monthly } = summary;

        let msg = '📈 Сводный отчёт кассы (' + label + ')\n\n';

        if (monthly.length === 0) {
          msg += '📭 Данных нет\n';
        } else {
          monthly.forEach((m, i) => {
            const [year, month] = m.month.split('-');
            const monthName = new Date(year, month - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
            msg += (i + 1) + '. ' + monthName + '\n';
            msg += '   💵 $' + parseFloat(m.usd).toLocaleString('ru-RU') + '\n';
            msg += '   💴 ' + parseFloat(m.somoni).toLocaleString('ru-RU') + ' сом\n';
            msg += '   📦 ' + m.count + ' записей\n';
          });
        }

        msg += '\n━━━━━━━━━━━━━━━\n';
        msg += '💵 Итого: *$' + parseFloat(totals.total_usd).toLocaleString('ru-RU') + '*\n';
        msg += '💴 Итого: *' + parseFloat(totals.total_somoni).toLocaleString('ru-RU') + ' сом*\n';
        msg += '📦 Всего записей: ' + totals.count;

        // Генерируем Excel
        const excelExporter = require('./excel-export');
        const excelResult = await excelExporter.exportCashSummary(days || null);

        await ctx.editMessageText(msg, { parse_mode: 'Markdown' });

        if (excelResult.success) {
          await ctx.replyWithDocument(
            { source: excelResult.filePath, filename: excelResult.fileName },
            { caption: '📈 Сводный отчёт кассы: ' + label }
          );
        }
      } catch (error) {
        console.error('Ошибка сводного отчёта:', error);
        await ctx.answerCbQuery('❌ Ошибка');
      }
    }

    if (callbackData === 'cash_report_send') {
      try {
        const lastSent = await database.getLastCashReportSent();
        const totals = await database.getCashTotals();
        const records = await database.getCashReport();

        const fromDate = lastSent
          ? new Date(lastSent).toLocaleDateString('ru-RU')
          : 'начала';
        const toDate = new Date().toLocaleDateString('ru-RU');

        let msg = '📊 ОТЧЁТ КАССЫ\n';
        msg += '📅 ' + fromDate + ' — ' + toDate + '\n\n';

        records.forEach((r, i) => {
          const date = new Date(r.created_at).toLocaleDateString('ru-RU');
          msg += (i + 1) + '. ' + r.client_name + '\n';
          if (r.mode === 'usd' || r.mode === 'both') msg += '   💵 $' + parseFloat(r.usd).toLocaleString('ru-RU') + '\n';
          if (r.mode === 'somoni' || r.mode === 'both') msg += '   💴 ' + parseFloat(r.somoni).toLocaleString('ru-RU') + ' сом\n';
          msg += '   📅 ' + date + '\n';
        });

        msg += '\n━━━━━━━━━━━━━━━\n';
        msg += '💵 Итого: $' + parseFloat(totals.total_usd).toLocaleString('ru-RU') + '\n';
        msg += '💴 Итого: ' + parseFloat(totals.total_somoni).toLocaleString('ru-RU') + ' сом';

        // Генерируем Excel
        const excelExporter = require('./excel-export');
        const excelResult = await excelExporter.exportCashReport();

        // Отправляем WhatsApp кассиру
        const cashierPhone = process.env.CASHIER_WHATSAPP_PHONE || process.env.WHATSAPP_RECIPIENT;
        const cashierInstanceId = process.env.GREEN_API_INSTANCE_ID_PERSONAL || process.env.GREEN_API_INSTANCE_ID;
        const cashierToken = process.env.GREEN_API_TOKEN_PERSONAL || process.env.GREEN_API_TOKEN;
        const sent = await whatsapp.sendMessage(msg, cashierPhone, cashierInstanceId, cashierToken);

        if (excelResult.success) {
          await ctx.replyWithDocument(
            { source: excelResult.filePath, filename: excelResult.fileName },
            { caption: '📊 Отчёт кассы: ' + fromDate + ' — ' + toDate }
          );
          await whatsapp.sendFile(
            excelResult.filePath, excelResult.fileName,
            '📊 Отчёт кассы: ' + fromDate + ' — ' + toDate,
            cashierPhone, cashierInstanceId, cashierToken
          );
        }

        // Сбрасываем период после успешной отправки
        if (sent) await database.markCashReportSent();

        await ctx.answerCbQuery(sent ? '✅ Отправлено!' : '❌ Ошибка WhatsApp');
        await ctx.editMessageText(
          (sent ? '✅ Отчёт передан кассиру!\n\n' : '⚠️ WhatsApp не отправлен\n\n') + msg
        );
      } catch (error) {
        console.error('Ошибка отправки отчёта:', error);
        await ctx.answerCbQuery('❌ Ошибка');
      }
    }


        if (callbackData === 'cash_report_close') {
      await ctx.answerCbQuery('Закрыто');
      await ctx.editMessageText('📊 Отчёт закрыт');
    }

    if (callbackData === 'cash_report_send') {
      try {
        const totals = await database.getCashTotals(7);
        const records = await database.getCashReport(7);

        let msg = '📊 ОТЧЁТ КАССЫ (7 дней)\n\n';
        records.forEach((r, i) => {
          const date = new Date(r.created_at).toLocaleDateString('ru-RU');
          msg += `${i + 1}. ${r.client_name}\n`;
          if (r.mode === 'usd' || r.mode === 'both') msg += `   💵 $${parseFloat(r.usd).toLocaleString('ru-RU')}\n`;
          if (r.mode === 'somoni' || r.mode === 'both') msg += `   💴 ${parseFloat(r.somoni).toLocaleString('ru-RU')} сом\n`;
          msg += `   📅 ${date}\n`;
        });
        msg += `\n━━━━━━━━━━━━━━━\n`;
        msg += `💵 Итого: $${parseFloat(totals.total_usd).toLocaleString('ru-RU')}\n`;
        msg += `💴 Итого: ${parseFloat(totals.total_somoni).toLocaleString('ru-RU')} сом\n`;
        msg += `📅 ${new Date().toLocaleDateString('ru-RU')}`;

        const cashierPhone = process.env.CASHIER_WHATSAPP_PHONE || process.env.WHATSAPP_RECIPIENT;
        const cashierInstanceId = process.env.GREEN_API_INSTANCE_ID_PERSONAL || process.env.GREEN_API_INSTANCE_ID;
        const cashierToken = process.env.GREEN_API_TOKEN_PERSONAL || process.env.GREEN_API_TOKEN;

        const sent = await whatsapp.sendMessage(msg, cashierPhone, cashierInstanceId, cashierToken);
        await ctx.answerCbQuery(sent ? '✅ Отправлено!' : '❌ Ошибка');
        await ctx.editMessageText(sent
          ? '✅ Отчёт передан кассиру!\n\n' + msg
          : '❌ Ошибка отправки. Проверьте настройки WhatsApp.'
        );
      } catch (error) {
        console.error('Ошибка отправки отчёта:', error);
        await ctx.answerCbQuery('❌ Ошибка');
      }
    }

  } catch (error) {
    console.error('Ошибка обработки callback:', error);
    ctx.answerCbQuery('❌ Произошла ошибка');
  }
});

// Команда /profile - изменить свои данные
bot.command('profile', async (ctx) => {
  const userId = ctx.from.id;
  
  const isClientUser = await database.isClient(userId);
  
  if (!isClientUser && !admin.isAdmin(userId)) {
    return ctx.reply('❌ У вас нет доступа к боту');
  }
  
  try {
    const client = await database.getClient(userId);
    
    if (!client) {
      return ctx.reply('❌ Ваши данные не найдены');
    }
    
    const keyboard = [
      [{ text: '✏️ Изменить имя' }],
      [{ text: '✏️ Изменить телефон' }],
      [{ text: '🔙 Отмена' }]
    ];
    
    ctx.reply(
      '👤 Ваш профиль:\n\n' +
      `Имя: ${client.name || 'не указано'}\n` +
      `Телефон: ${client.phone || 'не указан'}\n\n` +
      'Что хотите изменить?',
      { reply_markup: { keyboard, resize_keyboard: true } }
    );
    
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    ctx.reply('❌ Ошибка при получении данных профиля');
  }
});

// Обработка изменения имени
bot.hears('✏️ Изменить имя', async (ctx) => {
  const userId = ctx.from.id;
  
  const isClientUser = await database.isClient(userId);
  
  if (!isClientUser && !admin.isAdmin(userId)) {
    return;
  }
  
  const data = orderData.get(userId) || {};
  data.editingProfile = 'name';
  orderData.set(userId, data);
  
  ctx.reply(
    '✏️ Введите новое имя:',
    { reply_markup: { remove_keyboard: true } }
  );
});

// Обработка изменения телефона
bot.hears('✏️ Изменить телефон', async (ctx) => {
  const userId = ctx.from.id;
  
  const isClientUser = await database.isClient(userId);
  
  if (!isClientUser && !admin.isAdmin(userId)) {
    return;
  }
  
  const data = orderData.get(userId) || {};
  data.editingProfile = 'phone';
  orderData.set(userId, data);
  
  ctx.reply(
    '✏️ Введите новый номер телефона:\n(например: +992900000000)',
    { reply_markup: { remove_keyboard: true } }
  );
});

bot.hears('🔙 Отмена', async (ctx) => {
  const userId = ctx.from.id;
  
  orderData.delete(userId);
  
  const isAdminUser = admin.isAdmin(userId);
  
  if (isAdminUser) {
    const keyboard = [
      [{ text: '📦 Создать заявку' }],
      [{ text: '💰 Касса' }],
      [{ text: '👨‍💼 Панель администратора' }]
    ];
    
    ctx.reply('Главное меню:', {
      reply_markup: { keyboard, resize_keyboard: true }
    });
  } else {
    const keyboard = [
      [{ text: '🏬 Склад' }]
    ];
    
    ctx.reply('Главное меню:', {
      reply_markup: { keyboard, resize_keyboard: true }
    });
  }
});

// Команда /cancel
bot.command('cancel', (ctx) => {
  orderData.delete(ctx.from.id);
  ctx.reply('❌ Заявка отменена. Для новой заявки нажмите /start', {
    reply_markup: { remove_keyboard: true }
  });
});

// Запуск бота
async function startBot() {
  try {
    console.log('🚀 Запуск бота...');
    console.log(`📋 NODE_ENV: ${process.env.NODE_ENV || 'не задан'}`);
    console.log(`🔑 TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ задан' : '❌ НЕ ЗАДАН'}`);
    console.log(`🗄️ DATABASE_URL: ${process.env.DATABASE_URL ? '✅ задан' : '❌ НЕ ЗАДАН'}`);
    console.log(`📱 GREEN_API_INSTANCE_ID: ${process.env.GREEN_API_INSTANCE_ID ? '✅ задан' : '❌ не задан'}`);
    console.log(`📱 GREEN_API_TOKEN: ${process.env.GREEN_API_TOKEN ? '✅ задан' : '❌ не задан'}`);
    console.log(`💬 TELEGRAM_GROUP_ID: ${process.env.TELEGRAM_GROUP_ID ? '✅ задан' : '❌ не задан'}`);

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_BOT_TOKEN не задан!');
      process.exit(1);
    }

    // Выполняем автоматическую миграцию перед запуском
    await autoMigrate();

    const PORT = parseInt(process.env.PORT) || 3000;

    // ── Всегда polling — надёжнее для Railway ────────────────────────────
    // Сначала удаляем старый webhook если был
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log('🔄 Запуск в polling режиме...');
    await bot.launch({
      allowedUpdates: ['message', 'callback_query', 'inline_query', 'chosen_inline_result', 'edited_message']
    });
    console.log('🤖 Бот запущен в polling режиме!');

    // Простой HTTP сервер чтобы Railway не завершал контейнер
    const http = require('http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
    }).listen(PORT, () => {
      console.log(`✅ Keep-alive сервер на порту ${PORT}`);
    });

    const botInfo = await bot.telegram.getMe();
    console.log('📱 Telegram: @' + botInfo.username);
    console.log('✅ Бот готов к работе!');

  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error);
    process.exit(1);
  }
}

startBot();

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  database.close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  database.close();
});

// Экспортируем функцию для использования в admin.js
module.exports = { loadWarehousesAndProducts, dataManager };
