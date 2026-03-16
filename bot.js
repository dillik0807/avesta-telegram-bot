require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const database = require('./database');
const whatsapp = require('./whatsapp');
const admin = require('./admin');
const dataManager = require('./data-manager');

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

// Очистка устаревших данных заявок (старше 2 часов)
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of orderData.entries()) {
    if (data.createdAt && (now - data.createdAt) > 2 * 60 * 60 * 1000) {
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
  
  message += `\n📅 Дата: ${new Date().toLocaleDateString('ru-RU')}`;
  
  return message;
}

// Команда /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || ctx.from.username || 'Пользователь';
  
  // Проверка прав доступа
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  
  if (isAdminUser) {
    const keyboard = [
      [{ text: '📦 Создать заявку' }],
      [{ text: '👨‍💼 Панель администратора' }]
    ];
    
    return ctx.reply(
      '👋 Добро пожаловать, администратор!\n\n' +
      'Выберите действие:',
      { reply_markup: { keyboard, resize_keyboard: true } }
    );
  }
  
  if (isClientUser) {
    // Показываем постоянное меню
    const keyboard = [
      [{ text: '🏬 Склад' }]
    ];
    
    return ctx.reply(
      '👋 Добро пожаловать в систему приема заявок!\n\n' +
      'Нажмите "🏬 Склад" чтобы создать заявку',
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
  
  if (!admin.isAdmin(userId)) {
    return;
  }
  
  // Начинаем процесс создания заявки
  orderData.set(userId, { items: [], step: 'warehouse', createdAt: Date.now() });
  
  // 🔄 Всегда загружаем свежие данные складов из БД
  console.log('🔄 Обновление списка складов из БД...');
  await reloadWarehousesAndProducts();
  
  const keyboard = getWarehouses().map(w => [{ text: w }]);
  
  ctx.reply(
    '📦 Создание новой заявки\n\n' +
    '🏬 Выберите склад:',
    { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } }
  );
});

// Обработка кнопки "🏬 Склад" - начало создания заявки
bot.hears('🏬 Склад', async (ctx) => {
  const userId = ctx.from.id;
  
  const isAdminUser = admin.isAdmin(userId);
  const isClientUser = await database.isClient(userId);
  
  if (!isAdminUser && !isClientUser) {
    return;
  }
  
  // Начинаем процесс создания заявки
  orderData.set(userId, { items: [], step: 'warehouse', createdAt: Date.now() });
  
  // 🔄 Всегда загружаем свежие данные складов из БД
  console.log('🔄 Обновление списка складов из БД...');
  await reloadWarehousesAndProducts();
  
  const keyboard = getWarehouses().map(w => [{ text: w }]);
  
  ctx.reply(
    '🏬 Выберите склад:',
    { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } }
  );
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
    [{ text: '🏬 Управление складами' }],
    [{ text: '🛒 Управление товарами' }],
    [{ text: '💰 Касса' }],
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
    [{ text: '👨‍💼 Панель администратора' }]
  ];
  
  ctx.reply(
    'Главное меню:',
    { reply_markup: { keyboard, resize_keyboard: true } }
  );
});

// ============================================================
// 💰 КАССА — инкассо кассиру через WhatsApp
// ============================================================

bot.hears('💰 Касса', async (ctx) => {
  const userId = ctx.from.id;
  if (!admin.isAdmin(userId)) return;

  orderData.set(userId, { step: 'cash_search', createdAt: Date.now() });

  ctx.reply(
    '💰 Касса — Инкассо\n\n🔍 Введите имя или телефон клиента:',
    { reply_markup: { remove_keyboard: true } }
  );
});


// Вспомогательная функция: формирует и показывает шаблон инкассо
async function buildCashMessage(ctx, userId, data) {
  const client = data.cashClient;
  const lines = [
    '💰 ИНКАССО',
    '',
    '👤 Клиент: ' + client.name,
    '📞 Телефон: ' + (client.phone || 'не указан')
  ];

  if (data.cashMode === 'usd') {
    lines.push('💵 Доллар: $' + data.cashUsd.toLocaleString('ru-RU'));
  }

  if (data.cashMode === 'somoni') {
    lines.push('💴 Сомони: ' + data.cashSomoni.toLocaleString('ru-RU') + ' сом');
    lines.push('📈 Курс: ' + data.cashRate.toLocaleString('ru-RU'));
    const equiv = (data.cashSomoni / data.cashRate).toFixed(2);
    lines.push('💵 Эквивалент: $' + parseFloat(equiv).toLocaleString('ru-RU'));
  }

  if (data.cashMode === 'both') {
    lines.push('💵 Доллар: $' + data.cashUsd.toLocaleString('ru-RU'));
    lines.push('💴 Сомони: ' + data.cashSomoni.toLocaleString('ru-RU') + ' сом');
    lines.push('📈 Курс: ' + data.cashRate.toLocaleString('ru-RU'));
    const totalSomoni = Math.round(data.cashUsd * data.cashRate) + data.cashSomoni;
    lines.push('💰 Итого в сомони: ' + totalSomoni.toLocaleString('ru-RU') + ' сом');
  }

  lines.push('📅 ' + new Date().toLocaleDateString('ru-RU'));

  const cashMessage = lines.join('\n');
  data.cashMessage = cashMessage;
  data.step = 'cash_confirm';
  orderData.set(userId, data);

  const cashierPhone = process.env.CASHIER_WHATSAPP_PHONE || process.env.WHATSAPP_RECIPIENT;

  return ctx.reply(
    '📋 Шаблон сообщения кассиру:\n\n' + cashMessage + '\n\n' +
    '📱 Кассир: ' + (cashierPhone || '❌ не настроен') + '\n\nОтправить?',
    {
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
    // ── Касса: поиск клиента ──
    if (data.step === 'cash_search' && isAdminUser) {
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
    if (data.step === 'cash_enter_usd' && isAdminUser) {
      const amount = text.trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(amount)) {
        return ctx.reply('⚠️ Введите сумму числом (например: 500)');
      }
      data.cashUsd = parseFloat(amount);
      if (data.cashMode === 'usd') {
        return buildCashMessage(ctx, userId, data);
      }
      data.step = 'cash_enter_somoni';
      orderData.set(userId, data);
      return ctx.reply(`💵 Доллар: $${data.cashUsd.toLocaleString('ru-RU')}\n\n💴 Введите сумму в сомони:`);
    }

    // ── Касса: ввод суммы (сомони) ──
    if (data.step === 'cash_enter_somoni' && isAdminUser) {
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
    if (data.step === 'cash_enter_rate' && isAdminUser) {
      const rate = text.trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(rate)) {
        return ctx.reply('⚠️ Введите курс числом (например: 10900)');
      }
      data.cashRate = parseFloat(rate);
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
          ? [[{ text: '📦 Создать заявку' }], [{ text: '👨‍💼 Панель администратора' }]]
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
          ? [[{ text: '📦 Создать заявку' }], [{ text: '👨‍💼 Панель администратора' }]]
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
      // Проверяем, что введено число
      const quantity = text.trim();
      
      data.items = data.items || [];
      data.items.push({
        product: data.currentProduct,
        quantity: quantity + ' шт'  // Автоматически добавляем "шт"
      });
      delete data.currentProduct;
      
      // Спрашиваем, нужно ли добавить еще товары
      data.step = 'add_more';
      orderData.set(userId, data);
      
      const keyboard = [
        [{ text: '➕ Добавить еще товар' }],
        [{ text: '✅ Продолжить' }]
      ];
      
      let message = '✅ Товар добавлен!\n\n';
      message += `🏬 Склад: ${data.warehouse}\n\n`;
      message += 'Товары:\n';
      data.items.forEach((item, i) => {
        message += `${i + 1}. ${item.product} — ${item.quantity}\n`;
      });
      message += '\nЧто дальше?';
      
      return ctx.reply(message, {
        reply_markup: { keyboard, resize_keyboard: true }
      });
    }

    // Шаг 4: Добавить еще товар или продолжить
    if (data.step === 'add_more') {
      if (text === '➕ Добавить еще товар') {
        data.step = 'product';
        orderData.set(userId, data);
        
        // 🔄 Обновляем товары из БД перед показом
        console.log('🔄 Обновление списка товаров из БД...');
        await loadWarehousesAndProducts();
        
        const keyboard = getProducts().map(p => [{ text: p }]);
        
        return ctx.reply(
          '🛒 Выберите товар:',
          { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } }
        );
      }
      
      if (text === '✅ Продолжить') {
        // Для администратора запрашиваем поиск клиента
        if (isAdminUser) {
          data.step = 'search_client';
          orderData.set(userId, data);
          
          let summary = '📋 Ваша заявка:\n\n';
          summary += `🏬 Склад: ${data.warehouse}\n\n`;
          summary += 'Товары:\n';
          data.items.forEach((item, i) => {
            summary += `${i + 1}. ${item.product} — ${item.quantity}\n`;
          });
          summary += '\n🔍 Введите имя клиента или часть имени для поиска:\n';
          summary += '(например: Иван или Ива)';
          
          return ctx.reply(summary, { reply_markup: { remove_keyboard: true } });
        }
        
        // Для обычного клиента - проверяем сохраненные данные
        const client = await database.getClient(userId);
        
        if (client && client.name && client.phone && client.name.trim() !== '' && client.phone.trim() !== '') {
          // Данные уже есть и заполнены - сразу запрашиваем транспорт
          data.name = client.name;
          data.phone = client.phone;
          data.step = 'transport';
          orderData.set(userId, data);
          
          let summary = '📋 Ваша заявка:\n\n';
          summary += `👤 Имя: ${client.name}\n`;
          summary += `📞 Телефон: ${client.phone}\n`;
          summary += `🏬 Склад: ${data.warehouse}\n\n`;
          summary += 'Товары:\n';
          data.items.forEach((item, i) => {
            summary += `${i + 1}. ${item.product} — ${item.quantity}\n`;
          });
          summary += '\n🚚 Введите номер транспорта:\n(например: 1234 AB)';
          
          return ctx.reply(summary, { reply_markup: { remove_keyboard: true } });
        } else {
          // Данные не заполнены или клиент новый - запрашиваем имя и телефон
          data.step = 'name';
          orderData.set(userId, data);
          
          let summary = '📋 Ваша заявка:\n\n';
          summary += `🏬 Склад: ${data.warehouse}\n\n`;
          summary += 'Товары:\n';
          data.items.forEach((item, i) => {
            summary += `${i + 1}. ${item.product} — ${item.quantity}\n`;
          });
          
          if (client && client.name && client.name.trim() !== '') {
            summary += '\n📝 Обновите ваши контактные данные:\n\n';
            summary += `Ваше текущее имя: ${client.name}\n`;
            summary += 'Введите новое имя или отправьте "-" чтобы оставить текущее:';
          } else {
            summary += '\n📝 Заполните контактные данные:\n\n';
            summary += 'Введите ваше имя:';
          }
          
          return ctx.reply(summary, { reply_markup: { remove_keyboard: true } });
        }
      }
    }

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
      data.transport = text;
      data.step = 'comment';
      orderData.set(userId, data);
      return ctx.reply('📝 Введите комментарий или отправьте "-" чтобы пропустить:');
    }

    // Шаг 8: Комментарий
    if (data.step === 'comment') {
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
      ctx.reply('❌ Заявка отменена. Для новой заявки нажмите /start', {
        reply_markup: { remove_keyboard: true }
      });
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
  
  if (!isAdminUser) {
    return ctx.answerCbQuery('❌ У вас нет прав для этого действия');
  }
  
  try {
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

      const sent = await whatsapp.sendMessage(data.cashMessage, cashierPhone);
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
            keyboard: [[{ text: '📦 Создать заявку' }], [{ text: '👨‍💼 Панель администратора' }]],
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
      console.error('💡 Добавьте переменную окружения TELEGRAM_BOT_TOKEN в Railway');
      process.exit(1);
    }
    
    // Выполняем автоматическую миграцию перед запуском
    await autoMigrate();
    
    const PORT = process.env.PORT || 3000;
    const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    
    if (WEBHOOK_DOMAIN) {
      // Webhook режим для Railway/production
      const domain = WEBHOOK_DOMAIN.startsWith('https://') ? WEBHOOK_DOMAIN : `https://${WEBHOOK_DOMAIN}`;
      console.log(`🌐 Запуск в webhook режиме: ${domain}, порт: ${PORT}`);
      
      await bot.launch({
        webhook: {
          domain: domain,
          port: PORT
        }
      });
      
      console.log('🤖 Бот запущен в webhook режиме!');
    } else {
      // Polling режим для локальной разработки
      console.log('🔄 Запуск в polling режиме (локальная разработка)...');
      await bot.launch();
      console.log('🤖 Бот запущен в polling режиме!');
    }
    
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
