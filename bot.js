/**
 * 🤖 Telegram бот для системы учёта товаров Avesta
 * С авторизацией пользователей и поддержкой Firebase Admin SDK
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const ExcelJS = require('exceljs');
const path = require('path');

// 🔧 Загружаем все исправления
const botFixes = require('./fix-telegram-bot-all');
console.log('🔧 Исправления Telegram Bot загружены');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL;
const DEFAULT_YEAR = '2026';
const SESSIONS_FILE = './sessions.json';
const SERVICE_ACCOUNT_FILE = './firebase-service-account.json';

if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN не указан!');
    process.exit(1);
}

// Инициализация Firebase Admin SDK
let firebaseAdmin = null;
let firebaseDb = null;

// Попробуем инициализировать из переменной окружения (для Railway)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const admin = require('firebase-admin');
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
        firebaseDb = admin.database();
        firebaseAdmin = admin;
        console.log('✅ Firebase Admin SDK инициализирован (из ENV)');
    } catch (e) {
        console.log('⚠️ Ошибка инициализации Firebase из ENV:', e.message);
    }
}
// Иначе пробуем из файла (для локальной разработки)
else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
        const admin = require('firebase-admin');
        const serviceAccount = require(SERVICE_ACCOUNT_FILE);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
        firebaseDb = admin.database();
        firebaseAdmin = admin;
        console.log('✅ Firebase Admin SDK инициализирован (из файла)');
    } catch (e) {
        console.log('⚠️ Не удалось инициализировать Firebase Admin:', e.message);
    }
}

const bot = new Telegraf(BOT_TOKEN);
console.log('🤖 Бот запускается...');

// Сессии авторизованных пользователей (в памяти для Railway)
let sessions = {};
try {
    if (fs.existsSync(SESSIONS_FILE)) {
        sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
} catch (e) { sessions = {}; }

const saveSessions = () => {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch (e) {}
};

// Хеширование пароля (как в приложении - чистый SHA-256 без соли)
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

// Проверка авторизации
const isAuthorized = (userId) => sessions[userId] && sessions[userId].authorized;
const getSession = (userId) => sessions[userId] || {};
const getUserYear = (userId) => getSession(userId).year || DEFAULT_YEAR;
const getUserWarehouseGroups = (userId) => getSession(userId).warehouseGroup || [];
const setUserYear = (userId, year) => {
    if (sessions[userId]) {
        sessions[userId].year = year;
        saveSessions();
    }
};

// Проверка доступа к складу по группе
const canAccessWarehouse = (userId, warehouseName, warehouseGroups) => {
    const session = getSession(userId);
    // Админ видит всё
    if (session.role === 'admin') return true;
    // Если у пользователя нет ограничений по группам - видит всё
    const userGroups = session.warehouseGroup || [];
    if (!userGroups || userGroups.length === 0 || !userGroups[0]) return true;
    // Проверяем группу склада
    const whGroup = warehouseGroups[warehouseName];
    if (!whGroup) return true; // Если у склада нет группы - показываем
    return userGroups.includes(whGroup);
};

// Фильтрация данных по группам складов пользователя
const filterDataByWarehouseGroup = (data, userId) => {
    const session = getSession(userId);
    // Админ видит всё
    if (session.role === 'admin') return data;
    // Если у пользователя нет ограничений по группам - видит всё
    const userGroups = session.warehouseGroup || [];
    if (!userGroups || userGroups.length === 0 || !userGroups[0]) return data;
    
    // Получаем маппинг склад -> группа
    const warehouseToGroup = {};
    (data.warehouses || []).forEach(w => {
        if (w.name && w.group) {
            warehouseToGroup[w.name] = w.group;
        }
    });
    
    // Функция проверки доступа к складу
    const hasAccess = (warehouseName) => {
        const whGroup = warehouseToGroup[warehouseName];
        if (!whGroup) return true; // Если у склада нет группы - показываем
        return userGroups.includes(whGroup);
    };
    
    // Фильтруем данные года
    const filteredData = JSON.parse(JSON.stringify(data)); // Глубокая копия
    
    if (filteredData.years) {
        Object.keys(filteredData.years).forEach(year => {
            const yearData = filteredData.years[year];
            
            // Фильтруем приход
            if (yearData.income) {
                yearData.income = yearData.income.filter(item => hasAccess(item.warehouse));
            }
            
            // Фильтруем расход
            if (yearData.expense) {
                yearData.expense = yearData.expense.filter(item => hasAccess(item.warehouse));
            }
        });
    }
    
    // Фильтруем список складов
    if (filteredData.warehouses) {
        filteredData.warehouses = filteredData.warehouses.filter(w => {
            if (!w.group) return true;
            return userGroups.includes(w.group);
        });
    }
    
    return filteredData;
};

// Получение данных из Firebase
const getData = () => new Promise(async (resolve, reject) => {
    // Если есть Admin SDK - используем его
    if (firebaseDb) {
        try {
            console.log('📡 Запрос данных из Firebase...');
            const snapshot = await firebaseDb.ref('/').once('value');
            const rawData = snapshot.val();
            console.log('📦 Данные получены, ключи:', rawData ? Object.keys(rawData) : 'null');
            
            // Проверяем разные структуры данных
            let data = rawData;
            
            // Если данные в retailAppData
            if (rawData && rawData.retailAppData) {
                console.log('📂 Используем retailAppData');
                data = rawData.retailAppData;
            }
            
            // Если данные в data
            if (rawData && rawData.data) {
                console.log('📂 Используем data');
                data = rawData.data;
            }
            
            if (data) {
                console.log('📂 Ключи данных:', Object.keys(data));
            }
            
            resolve(data);
            return;
        } catch (e) {
            console.error('Firebase Admin ошибка:', e.message);
        }
    }
    
    // Иначе пробуем REST API
    https.get(`${FIREBASE_URL}/.json`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed && parsed.error) {
                    console.log('Firebase REST ошибка:', parsed.error);
                    resolve(null);
                } else {
                    // Проверяем структуру
                    if (parsed && parsed.retailAppData) {
                        resolve(parsed.retailAppData);
                    } else if (parsed && parsed.data) {
                        resolve(parsed.data);
                    } else {
                        resolve(parsed);
                    }
                }
            } catch (e) { reject(e); }
        });
    }).on('error', reject);
});

// Форматирование чисел (используем безопасную версию)
const formatNumber = (num) => {
    // 🔧 Используем безопасную функцию из модуля исправлений
    if (typeof global.formatNumberSafe === 'function') {
        return global.formatNumberSafe(num);
    }
    
    // Fallback на оригинальную функцию
    return (num || 0).toFixed(2);
};

// Расчёт остатков
const calculateStock = (data, year) => {
    const yearData = data?.years?.[year];
    if (!yearData) return null;

    const balances = {};
    // Фильтруем удаленные записи из приходов
    (yearData.income || []).filter(item => !item.isDeleted).forEach(i => {
        const key = `${i.warehouse}|${i.company}|${i.product}`;
        if (!balances[key]) balances[key] = { warehouse: i.warehouse, company: i.company, product: i.product, income: 0, expense: 0 };
        balances[key].income += i.qtyFact || 0;
    });
    // Фильтруем удаленные записи из расходов
    (yearData.expense || []).filter(item => !item.isDeleted).forEach(e => {
        const key = `${e.warehouse}|${e.company}|${e.product}`;
        if (!balances[key]) balances[key] = { warehouse: e.warehouse, company: e.company, product: e.product, income: 0, expense: 0 };
        balances[key].expense += e.quantity || 0;
    });

    const byWarehouse = {};
    Object.values(balances).forEach(item => {
        const balance = item.income - item.expense;
        if (balance !== 0) {
            if (!byWarehouse[item.warehouse]) byWarehouse[item.warehouse] = [];
            byWarehouse[item.warehouse].push({ company: item.company, product: item.product, tons: balance / 20 });
        }
    });
    return byWarehouse;
};

// Расчёт фактического остатка (как в веб-приложении)
const calculateFactBalance = (data, year) => {
    const yearData = data?.years?.[year];
    if (!yearData) return null;

    // Создаем структуру для хранения остатков
    const summary = {};

    // Обрабатываем приход
    (yearData.income || []).filter(item => !item.isDeleted).forEach(item => {
        const key = `${item.warehouse}-${item.company}-${item.product}`;
        if (!summary[key]) {
            summary[key] = {
                warehouse: item.warehouse,
                company: item.company,
                product: item.product,
                income: 0,
                expense: 0
            };
        }
        summary[key].income += parseFloat(item.qtyFact) || 0;
    });

    // Обрабатываем расход
    (yearData.expense || []).filter(item => !item.isDeleted).forEach(item => {
        const key = `${item.warehouse}-${item.company}-${item.product}`;
        if (!summary[key]) {
            summary[key] = {
                warehouse: item.warehouse,
                company: item.company,
                product: item.product,
                income: 0,
                expense: 0
            };
        }
        summary[key].expense += parseFloat(item.quantity) || 0;
    });

    // Группируем по складам и товарам
    const warehouses = {};
    const productTotals = {};
    
    // Получаем группы складов
    const warehouseGroups = {};
    (data.warehouses || []).forEach(w => {
        if (w.name && w.group) {
            warehouseGroups[w.name] = w.group;
        }
    });

    Object.values(summary).forEach(item => {
        const balance = item.income - item.expense;
        const balanceTons = balance / 20;

        if (balanceTons !== 0) {
            // По складам
            if (!warehouses[item.warehouse]) {
                warehouses[item.warehouse] = {};
            }
            if (!warehouses[item.warehouse][item.product]) {
                warehouses[item.warehouse][item.product] = 0;
            }
            warehouses[item.warehouse][item.product] += balanceTons;

            // Итого по товарам
            if (!productTotals[item.product]) {
                productTotals[item.product] = 0;
            }
            productTotals[item.product] += balanceTons;
        }
    });

    return {
        warehouses,
        warehouseGroups,
        productTotals
    };
};

// Расчёт расхода товаров за сегодня
const calculateTodayExpense = (data, year) => {
    const yearData = data?.years?.[year];
    if (!yearData || !yearData.expense) return null;

    // Получаем сегодняшнюю дату в формате YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];
    
    // Фильтруем расходы только за сегодня
    const todayExpense = (yearData.expense || [])
        .filter(item => !item.isDeleted && item.date === today);

    if (todayExpense.length === 0) {
        return null;
    }

    // Группируем расходы только по товарам (БЕЗ складов и фирм)
    const expenseByProduct = {};

    todayExpense.forEach(item => {
        const product = item.product;
        
        if (!expenseByProduct[product]) {
            expenseByProduct[product] = 0;
        }
        
        // Конвертируем в тонны (quantity / 20)
        const tons = (parseFloat(item.quantity) || 0) / 20;
        expenseByProduct[product] += tons;
    });

    return expenseByProduct;
};

// Расчёт итогов вагонов
const calculateWagonTotals = (data, year) => {
    const yearData = data?.years?.[year];
    if (!yearData || !yearData.income) return null;

    const totals = {};

    yearData.income.filter(item => !item.isDeleted).forEach(item => {
        const key = `${item.product}-${item.company}-${item.warehouse}`;
        if (!totals[key]) {
            totals[key] = {
                product: item.product || '',
                company: item.company || '',
                warehouse: item.warehouse || '',
                wagons: 0,
                qtyDoc: 0,
                qtyFact: 0,
                weightTons: 0
            };
        }
        totals[key].wagons++;
        totals[key].qtyDoc += parseFloat(item.qtyDoc) || 0;
        totals[key].qtyFact += parseFloat(item.qtyFact) || 0;
        totals[key].weightTons += (parseFloat(item.qtyFact) || 0) / 20;
    });

    const items = Object.values(totals);
    
    // Общие итоги
    let grandTotalWagons = 0;
    let grandTotalDoc = 0;
    let grandTotalFact = 0;
    let grandTotalWeight = 0;

    items.forEach(item => {
        grandTotalWagons += item.wagons;
        grandTotalDoc += item.qtyDoc;
        grandTotalFact += item.qtyFact;
        grandTotalWeight += item.weightTons;
    });

    return {
        items,
        totals: {
            wagons: grandTotalWagons,
            qtyDoc: grandTotalDoc,
            qtyFact: grandTotalFact,
            difference: grandTotalFact - grandTotalDoc,
            weightTons: grandTotalWeight
        }
    };
};

// Расчёт расхода по клиентам
const calculateClientExpense = (data, year, dateFrom, dateTo) => {
    const yearData = data?.years?.[year];
    if (!yearData || !yearData.expense) return null;

    let expense = yearData.expense;
    
    // Фильтрация по датам
    if (dateFrom || dateTo) {
        expense = expense.filter(item => {
            const itemDate = new Date(item.date);
            if (dateFrom && itemDate < dateFrom) return false;
            if (dateTo && itemDate > dateTo) return false;
            return true;
        });
    }
    
    // Формируем данные
    const items = expense.map(item => ({
        date: item.date || '',
        client: item.client || '',
        product: item.product || '',
        company: item.company || '',
        warehouse: item.warehouse || '',
        quantity: parseFloat(item.quantity) || 0,
        tons: (parseFloat(item.quantity) || 0) / 20,
        price: parseFloat(item.price) || 0,
        total: parseFloat(item.total) || 0,
        notes: item.notes || ''
    }));
    
    // Сортируем по дате
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Итоги
    let totalQty = 0, totalTons = 0, totalSum = 0;
    items.forEach(item => {
        totalQty += item.quantity;
        totalTons += item.tons;
        totalSum += item.total;
    });
    
    return {
        items,
        totals: {
            quantity: totalQty,
            tons: totalTons,
            sum: totalSum
        }
    };
};

// Расчёт отчёта за день (используем исправленную версию)
const calculateDailyReport = (data, year, reportDate) => {
    // 🔧 Используем исправленную функцию из модуля исправлений
    if (typeof global.calculateDailyReportFixed === 'function') {
        return global.calculateDailyReportFixed(data, year, reportDate);
    }
    
    // Fallback на оригинальную функцию если исправления не загружены
    console.log('⚠️ Используем оригинальную функцию calculateDailyReport');
    const yearData = data?.years?.[year];
    if (!yearData) return { income: [], expense: [], totals: { expenseSum: 0 } };

    // Фильтруем удаленные записи из приходов
    const income = (yearData.income || []).filter(item => item.date === reportDate && !item.isDeleted).map(item => ({
        date: item.date,
        wagon: item.wagon || '',
        company: item.company || '',
        warehouse: item.warehouse || '',
        product: item.product || '',
        qtyDoc: parseFloat(item.qtyDoc) || 0,
        qtyFact: parseFloat(item.qtyFact) || 0,
        weightTons: (parseFloat(item.qtyFact) || 0) / 20
    }));

    // Фильтруем удаленные записи из расходов
    const expense = (yearData.expense || []).filter(item => item.date === reportDate && !item.isDeleted).map(item => ({
        date: item.date,
        client: item.client || '',
        company: item.company || '',
        warehouse: item.warehouse || '',
        product: item.product || '',
        quantity: parseFloat(item.quantity) || 0,
        tons: (parseFloat(item.quantity) || 0) / 20,
        price: parseFloat(item.price) || 0,
        total: parseFloat(item.total) || 0,
        notes: item.notes || ''
    }));

    const expenseSum = expense.reduce((sum, item) => sum + item.total, 0);

    return { income, expense, totals: { expenseSum } };
};

// Расчёт долгов (используем исправленную версию)
const calculateDebts = (data, year) => {
    // 🔧 Используем исправленную функцию из модуля исправлений
    if (typeof global.calculateDebtsFixed === 'function') {
        return global.calculateDebtsFixed(data, year);
    }
    
    // Fallback на оригинальную функцию если исправления не загружены
    console.log('⚠️ Используем оригинальную функцию calculateDebts');
    const yearData = data?.years?.[year];
    if (!yearData) return null;

    const clientDebts = {};
    
    // Суммируем все расходы по клиентам (total - сумма к оплате), исключая удаленные
    (yearData.expense || []).filter(item => !item.isDeleted).forEach(e => {
        if (!e.client) return;
        if (!clientDebts[e.client]) clientDebts[e.client] = { total: 0, paid: 0 };
        clientDebts[e.client].total += e.total || 0;
    });
    
    // Суммируем все погашения по клиентам, исключая удаленные
    (yearData.payments || []).filter(item => !item.isDeleted).forEach(p => {
        if (!p.client) return;
        if (!clientDebts[p.client]) clientDebts[p.client] = { total: 0, paid: 0 };
        clientDebts[p.client].paid += p.amount || 0;
    });

    // Вычисляем остаток долга
    const result = {};
    Object.entries(clientDebts).forEach(([client, d]) => {
        const debt = d.total - d.paid;
        if (debt > 0) {
            result[client] = { total: d.total, paid: d.paid, debt };
        }
    });
    return result;
};

// Клавиатуры
const loginKeyboard = Markup.keyboard([['🔐 Войти']]).resize();
const mainKeyboard = Markup.keyboard([
    ['📦 Остатки складов', '🏭 Фактический остаток'],
    ['💰 Долги клиентов', '📊 Сводка'],
    ['📅 Отчёт за день', '📋 Отчёты'],
    ['📆 Сменить год', '🚪 Выйти']
]).resize();
// Клавиатура для администраторов (с кнопкой Управление)
const adminKeyboard = Markup.keyboard([
    ['📦 Остатки складов', '🏭 Фактический остаток'],
    ['💰 Долги клиентов', '📊 Сводка'],
    ['📅 Отчёт за день', '📋 Отчёты'],
    ['⚙️ Управление', '📆 Сменить год'],
    ['🚪 Выйти']
]).resize();
const reportsKeyboard = Markup.keyboard([
    ['📈 Приход за период', '📉 Расход за период'],
    ['💵 Погашения за период', '👥 Топ должников'],
    ['🚂 Итоги вагонов', ' Карточка клиента'],
    ['🔙 Назад']
]).resize();
const managementKeyboard = Markup.keyboard([
    ['👥 Пользователи', '📦 Товары'],
    ['🏢 Фирмы', '🏪 Склады'],
    ['👤 Клиенты', '💰 Цены'],
    ['📅 Годы', '🔙 Назад в меню']
]).resize();

// Получить клавиатуру в зависимости от роли
const getMainKeyboard = (userId) => {
    const session = getSession(userId);
    return session.role === 'admin' ? adminKeyboard : mainKeyboard;
};

// Middleware проверки авторизации
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    
    const text = ctx.message?.text || '';
    const publicCommands = ['/start', '🔐 Войти', '/login'];
    
    if (publicCommands.some(cmd => text.startsWith(cmd))) return next();
    if (getSession(userId).waitingForPassword) return next();
    if (getSession(userId).waitingForUsername) return next();
    if (getSession(userId).waitingForPrice) return next();
    
    if (!isAuthorized(userId)) {
        return ctx.reply('⛔ Требуется авторизация!\n\nНажмите "🔐 Войти" или отправьте /start', loginKeyboard);
    }
    
    return next();
});

// Команда /start
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    
    if (isAuthorized(userId)) {
        const session = getSession(userId);
        const year = getUserYear(userId);
        return ctx.reply(
            `🏭 *Avesta - Система учёта*\n\n👤 Вы вошли как: *${session.username}*\n📅 Год: *${year}*\n\nВыберите действие:`,
            { parse_mode: 'Markdown', ...getMainKeyboard(userId) }
        );
    }
    
    ctx.reply(
        `🏭 *Avesta - Система учёта товаров*\n\nДля доступа к данным необходимо войти.\nИспользуйте логин и пароль из приложения.`,
        { parse_mode: 'Markdown', ...loginKeyboard }
    );
});

// Начало авторизации
bot.hears(/🔐|\/login|войти/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (isAuthorized(userId)) {
        return ctx.reply('✅ Вы уже авторизованы!', getMainKeyboard(userId));
    }
    
    sessions[userId] = { waitingForUsername: true };
    saveSessions();
    ctx.reply('👤 Введите ваш логин:', Markup.removeKeyboard());
});

function getRoleText(role) {
    const roles = { 'admin': '👑 Администратор', 'warehouse': '🏪 Завсклад', 'cashier': '💵 Кассир', 'manager': '📊 Менеджер' };
    return roles[role] || role;
}

// Обработка ввода логина/пароля
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = getSession(userId);
    
    // Обработка ввода цены
    if (session.waitingForPrice) {
        const priceText = text;
        const price = parseFloat(priceText.replace(',', '.'));
        
        if (isNaN(price) || price <= 0) {
            return ctx.reply('❌ Введите корректную цену (число больше 0)');
        }
        
        const product = session.selectedPriceProduct;
        const group = session.selectedPriceGroup;
        const username = session.username;
        
        // Сбрасываем состояние
        sessions[userId].waitingForPrice = false;
        sessions[userId].selectedPriceProduct = null;
        sessions[userId].selectedPriceGroup = null;
        saveSessions();
        
        await ctx.reply('⏳ Сохранение цены...');
        
        try {
            // Сохраняем цену в Firebase
            const today = new Date().toISOString().split('T')[0];
            const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            
            const priceEntry = {
                price: price,
                time: time,
                user: username,
                timestamp: Date.now()
            };
            
            // Получаем текущие данные
            const data = await getData();
            if (!data) {
                return ctx.reply('❌ Ошибка подключения к базе данных', managementKeyboard);
            }
            
            // Инициализируем структуру если нужно
            if (!data.productPrices) data.productPrices = {};
            if (!data.productPrices[today]) data.productPrices[today] = {};
            if (!data.productPrices[today][product]) data.productPrices[today][product] = {};
            if (!data.productPrices[today][product][group]) data.productPrices[today][product][group] = [];
            
            // Добавляем цену
            data.productPrices[today][product][group].push(priceEntry);
            
            // Сохраняем в Firebase
            if (firebaseDb) {
                await firebaseDb.ref('retailAppData/productPrices').set(data.productPrices);
            }
            
            const groupName = group === 'ALL' ? 'Все склады' : group;
            
            ctx.reply(
                `✅ *Цена установлена!*\n\n` +
                `📦 Товар: *${product}*\n` +
                `🏪 Группа: *${groupName}*\n` +
                `💰 Цена: *${formatNumber(price)} $* за тонну\n` +
                `📅 Дата: ${today}\n` +
                `🕐 Время: ${time}`,
                { parse_mode: 'Markdown', ...managementKeyboard }
            );
            
        } catch (e) {
            console.error('Ошибка сохранения цены:', e);
            ctx.reply('❌ Ошибка сохранения цены', managementKeyboard);
        }
        
        return;
    }
    
    if (session.waitingForUsername) {
        sessions[userId] = { waitingForPassword: true, username: text };
        saveSessions();
        return ctx.reply('🔑 Введите пароль:');
    }
    
    if (session.waitingForPassword) {
        const username = session.username;
        const password = text;
        
        try { await ctx.deleteMessage(); } catch (e) {}
        
        const hashedPassword = hashPassword(password);
        
        try {
            const data = await getData();
            
            if (!data || !data.users) {
                // Проверяем admin локально если Firebase недоступен
                if (username === 'admin' && hashedPassword === hashPassword('P0l1uret@n@')) {
                    sessions[userId] = { authorized: true, username: 'admin', role: 'admin', year: DEFAULT_YEAR };
                    saveSessions();
                    return ctx.reply(`✅ Добро пожаловать, *admin*!\n\n⚠️ База данных недоступна.`, { parse_mode: 'Markdown', ...getMainKeyboard(userId) });
                }
                sessions[userId] = {};
                saveSessions();
                return ctx.reply('❌ Ошибка подключения к базе данных.\nПопробуйте позже.', loginKeyboard);
            }
            
            const user = data.users.find(u => u.username === username);
            
            if (!user) {
                sessions[userId] = {};
                saveSessions();
                return ctx.reply('❌ Пользователь не найден!', loginKeyboard);
            }
            
            if (user.blocked) {
                sessions[userId] = {};
                saveSessions();
                return ctx.reply('⛔ Ваш аккаунт заблокирован!', loginKeyboard);
            }
            
            if (user.password !== hashedPassword && user.password !== password) {
                sessions[userId] = {};
                saveSessions();
                return ctx.reply('❌ Неверный пароль!', loginKeyboard);
            }
            
            sessions[userId] = { 
                authorized: true, 
                username: user.username, 
                role: user.role, 
                year: DEFAULT_YEAR,
                warehouseGroup: user.warehouseGroup || []
            };
            saveSessions();
            
            ctx.reply(
                `✅ Добро пожаловать, *${user.username}*!\n\n👤 Роль: ${getRoleText(user.role)}\n📅 Год: *${DEFAULT_YEAR}*\n\nВыберите действие:`,
                { parse_mode: 'Markdown', ...getMainKeyboard(userId) }
            );
            
        } catch (err) {
            console.error('Ошибка авторизации:', err);
            sessions[userId] = {};
            saveSessions();
            ctx.reply('❌ Ошибка авторизации. Попробуйте позже.', loginKeyboard);
        }
        return;
    }
    
    return next();
});

// Выход
bot.hears(/🚪|\/logout|выйти/i, async (ctx) => {
    const userId = ctx.from.id;
    sessions[userId] = {};
    saveSessions();
    ctx.reply('👋 Вы вышли из системы.', loginKeyboard);
});

// Смена года
bot.hears(/📆|\/year|сменить год/i, async (ctx) => {
    const userId = ctx.from.id;
    const currentYear = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка списка годов...');
    
    try {
        const data = await getData();
        if (!data || !data.years) {
            return ctx.reply('❌ Не удалось получить список годов');
        }
        
        const years = Object.keys(data.years).sort().reverse();
        
        if (years.length === 0) {
            return ctx.reply('📅 Нет доступных годов');
        }
        
        // Создаём inline кнопки для годов
        const buttons = years.map(year => {
            const marker = year === currentYear ? ' ✓' : '';
            return [Markup.button.callback(`📅 ${year}${marker}`, `year_${year}`)];
        });
        
        ctx.reply(
            `📅 *Выберите год*\n\nТекущий год: *${currentYear}*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }
        );
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки списка годов');
    }
});

// Обработка выбора года
bot.action(/^year_(\d{4})$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = ctx.match[1];
    
    setUserYear(userId, year);
    
    await ctx.answerCbQuery(`✅ Год изменён на ${year}`);
    await ctx.editMessageText(
        `✅ Год успешно изменён на *${year}*`,
        { parse_mode: 'Markdown' }
    );
    
    ctx.reply(`📅 Теперь данные отображаются за *${year}* год`, { parse_mode: 'Markdown', ...getMainKeyboard(userId) });
});

// Меню отчётов
bot.hears(/📋|\/reports|отчёты|отчеты/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    ctx.reply(
        `📋 *МЕНЮ ОТЧЁТОВ*\n📅 Год: *${year}*\n\nВыберите тип отчёта:`,
        { parse_mode: 'Markdown', ...reportsKeyboard }
    );
});

// Назад в главное меню
bot.hears(/🔙 Назад в меню|назад в меню/i, async (ctx) => {
    const userId = ctx.from.id;
    ctx.reply('🏠 Главное меню', getMainKeyboard(userId));
});

// Назад из отчётов
bot.hears(/🔙|назад/i, async (ctx) => {
    const userId = ctx.from.id;
    ctx.reply('🏠 Главное меню', getMainKeyboard(userId));
});

// ==================== МЕНЮ УПРАВЛЕНИЯ (только для админов) ====================

// Проверка прав администратора
const isAdmin = (userId) => {
    const session = getSession(userId);
    return session.role === 'admin';
};

// Меню управления
bot.hears(/⚙️|управление/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён! Только для администраторов.');
    }
    
    ctx.reply(
        `⚙️ *УПРАВЛЕНИЕ*\n\nВыберите раздел:`,
        { parse_mode: 'Markdown', ...managementKeyboard }
    );
});

// Список пользователей
bot.hears(/👥 Пользователи/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.users) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        let msg = `👥 *ПОЛЬЗОВАТЕЛИ*\n${'═'.repeat(25)}\n\n`;
        
        data.users.forEach((user, i) => {
            const status = user.blocked ? '🔒' : '✅';
            const roleIcon = user.role === 'admin' ? '👑' : user.role === 'warehouse' ? '🏪' : user.role === 'cashier' ? '💵' : '📊';
            msg += `${i + 1}. ${status} *${user.username}*\n`;
            msg += `   ${roleIcon} ${getRoleText(user.role)}\n`;
            if (user.warehouseGroup && user.warehouseGroup.length > 0 && user.warehouseGroup[0]) {
                msg += `   🏪 Группы: ${user.warehouseGroup.join(', ')}\n`;
            }
            msg += `\n`;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${data.users.length}* пользователей`;
        
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Список товаров
bot.hears(/📦 Товары/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.products) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        let msg = `📦 *ТОВАРЫ*\n${'═'.repeat(25)}\n\n`;
        
        if (data.products.length === 0) {
            msg += `_Список пуст_\n`;
        } else {
            data.products.forEach((product, i) => {
                msg += `${i + 1}. ${product}\n`;
            });
        }
        
        msg += `\n${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${data.products.length}* товаров`;
        
        // Кнопка добавления
        const addButton = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Добавить товар', 'add_product')]
        ]);
        
        ctx.reply(msg, { parse_mode: 'Markdown', ...addButton });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Добавление товара - начало
bot.action('add_product', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещён!');
    
    await ctx.answerCbQuery();
    sessions[userId].waitingForNewProduct = true;
    saveSessions();
    
    ctx.reply('📦 Введите название нового товара:', Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'cancel_add')]
    ]));
});

// Добавление товара - обработка ввода
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    const text = ctx.message.text.trim();
    
    // Добавление товара
    if (session.waitingForNewProduct) {
        sessions[userId].waitingForNewProduct = false;
        saveSessions();
        
        if (text.startsWith('/') || text.startsWith('🔙')) {
            return ctx.reply('❌ Отменено', managementKeyboard);
        }
        
        try {
            const data = await getData();
            if (!data) return ctx.reply('❌ Ошибка подключения к базе', managementKeyboard);
            
            // Проверяем, существует ли уже
            if (data.products && data.products.includes(text)) {
                return ctx.reply(`❌ Товар "${text}" уже существует!`, managementKeyboard);
            }
            
            // Добавляем
            if (!data.products) data.products = [];
            data.products.push(text);
            data.products.sort();
            
            // Сохраняем в Firebase
            if (firebaseDb) {
                await firebaseDb.ref('retailAppData/products').set(data.products);
            }
            
            ctx.reply(`✅ Товар "*${text}*" добавлен!`, { parse_mode: 'Markdown', ...managementKeyboard });
        } catch (e) {
            console.error('Ошибка:', e);
            ctx.reply('❌ Ошибка сохранения', managementKeyboard);
        }
        return;
    }
    
    // Добавление фирмы
    if (session.waitingForNewCompany) {
        sessions[userId].waitingForNewCompany = false;
        saveSessions();
        
        if (text.startsWith('/') || text.startsWith('🔙')) {
            return ctx.reply('❌ Отменено', managementKeyboard);
        }
        
        try {
            const data = await getData();
            if (!data) return ctx.reply('❌ Ошибка подключения к базе', managementKeyboard);
            
            if (data.companies && data.companies.includes(text)) {
                return ctx.reply(`❌ Фирма "${text}" уже существует!`, managementKeyboard);
            }
            
            if (!data.companies) data.companies = [];
            data.companies.push(text);
            data.companies.sort();
            
            if (firebaseDb) {
                await firebaseDb.ref('retailAppData/companies').set(data.companies);
            }
            
            ctx.reply(`✅ Фирма "*${text}*" добавлена!`, { parse_mode: 'Markdown', ...managementKeyboard });
        } catch (e) {
            console.error('Ошибка:', e);
            ctx.reply('❌ Ошибка сохранения', managementKeyboard);
        }
        return;
    }
    
    // Добавление клиента
    if (session.waitingForNewClient) {
        sessions[userId].waitingForNewClient = false;
        saveSessions();
        
        if (text.startsWith('/') || text.startsWith('🔙')) {
            return ctx.reply('❌ Отменено', managementKeyboard);
        }
        
        try {
            const data = await getData();
            if (!data) return ctx.reply('❌ Ошибка подключения к базе', managementKeyboard);
            
            // Получаем текущих клиентов
            let clients = [];
            if (Array.isArray(data.clients)) {
                clients = data.clients.map(c => typeof c === 'string' ? c : (c.name || ''));
            }
            
            if (clients.includes(text)) {
                return ctx.reply(`❌ Клиент "${text}" уже существует!`, managementKeyboard);
            }
            
            // Добавляем как объект с именем
            if (!data.clients) data.clients = [];
            data.clients.push({ name: text });
            
            // Сортируем
            data.clients.sort((a, b) => {
                const nameA = typeof a === 'string' ? a : (a.name || '');
                const nameB = typeof b === 'string' ? b : (b.name || '');
                return nameA.localeCompare(nameB);
            });
            
            if (firebaseDb) {
                await firebaseDb.ref('retailAppData/clients').set(data.clients);
            }
            
            ctx.reply(`✅ Клиент "*${text}*" добавлен!`, { parse_mode: 'Markdown', ...managementKeyboard });
        } catch (e) {
            console.error('Ошибка:', e);
            ctx.reply('❌ Ошибка сохранения', managementKeyboard);
        }
        return;
    }
    
    return next();
});

// Отмена добавления
bot.action('cancel_add', async (ctx) => {
    const userId = ctx.from.id;
    sessions[userId].waitingForNewProduct = false;
    sessions[userId].waitingForNewCompany = false;
    sessions[userId].waitingForNewClient = false;
    saveSessions();
    
    await ctx.answerCbQuery('Отменено');
    ctx.reply('❌ Отменено', managementKeyboard);
});

// Список фирм
bot.hears(/🏢 Фирмы/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.companies) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        let msg = `🏢 *ФИРМЫ*\n${'═'.repeat(25)}\n\n`;
        
        if (data.companies.length === 0) {
            msg += `_Список пуст_\n`;
        } else {
            data.companies.forEach((company, i) => {
                msg += `${i + 1}. ${company}\n`;
            });
        }
        
        msg += `\n${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${data.companies.length}* фирм`;
        
        // Кнопка добавления
        const addButton = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Добавить фирму', 'add_company')]
        ]);
        
        ctx.reply(msg, { parse_mode: 'Markdown', ...addButton });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Добавление фирмы - начало
bot.action('add_company', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещён!');
    
    await ctx.answerCbQuery();
    sessions[userId].waitingForNewCompany = true;
    saveSessions();
    
    ctx.reply('🏢 Введите название новой фирмы:', Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'cancel_add')]
    ]));
});

// Список складов
bot.hears(/🏪 Склады/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.warehouses) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        if (data.warehouses.length === 0) {
            return ctx.reply('🏪 Список складов пуст');
        }
        
        let msg = `🏪 *СКЛАДЫ*\n${'═'.repeat(25)}\n\n`;
        
        // Группируем по группам
        const byGroup = {};
        data.warehouses.forEach(wh => {
            const group = wh.group || 'Без группы';
            if (!byGroup[group]) byGroup[group] = [];
            byGroup[group].push(wh.name);
        });
        
        Object.entries(byGroup).forEach(([group, warehouses]) => {
            msg += `📁 *${group}*\n`;
            warehouses.forEach((wh, i) => {
                msg += `   ${i + 1}. ${wh}\n`;
            });
            msg += `\n`;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${data.warehouses.length}* складов`;
        
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Список клиентов
bot.hears(/👤 Клиенты/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.clients) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        // Получаем имена клиентов (могут быть объекты или строки)
        let clientNames = [];
        if (Array.isArray(data.clients)) {
            data.clients.forEach(c => {
                if (typeof c === 'string') {
                    clientNames.push(c);
                } else if (c && c.name) {
                    clientNames.push(c.name);
                }
            });
        } else if (typeof data.clients === 'object') {
            Object.values(data.clients).forEach(c => {
                if (typeof c === 'string') {
                    clientNames.push(c);
                } else if (c && c.name) {
                    clientNames.push(c.name);
                }
            });
        }
        
        // Сортируем
        clientNames.sort();
        
        let msg = `👤 *КЛИЕНТЫ*\n${'═'.repeat(25)}\n\n`;
        
        if (clientNames.length === 0) {
            msg += `_Список пуст_\n`;
        } else {
            // Показываем первые 50 клиентов
            const showClients = clientNames.slice(0, 50);
            showClients.forEach((client, i) => {
                msg += `${i + 1}. ${client}\n`;
            });
            
            if (clientNames.length > 50) {
                msg += `\n_...и ещё ${clientNames.length - 50} клиентов_\n`;
            }
        }
        
        msg += `\n${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${clientNames.length}* клиентов`;
        
        // Кнопка добавления
        const addButton = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Добавить клиента', 'add_client')]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...addButton });
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown', ...addButton });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Добавление клиента - начало
bot.action('add_client', async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return ctx.answerCbQuery('⛔ Доступ запрещён!');
    
    await ctx.answerCbQuery();
    sessions[userId].waitingForNewClient = true;
    saveSessions();
    
    ctx.reply('👤 Введите имя нового клиента:', Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'cancel_add')]
    ]));
});

// Список годов
bot.hears(/📅 Годы/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.years) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        const years = Object.keys(data.years).sort().reverse();
        
        if (years.length === 0) {
            return ctx.reply('📅 Нет данных по годам');
        }
        
        let msg = `📅 *ГОДЫ*\n${'═'.repeat(25)}\n\n`;
        
        years.forEach(year => {
            const yearData = data.years[year];
            const incomeCount = (yearData.income || []).length;
            const expenseCount = (yearData.expense || []).length;
            const paymentsCount = (yearData.payments || []).length;
            
            msg += `📅 *${year}*\n`;
            msg += `   📦 Приход: ${incomeCount} записей\n`;
            msg += `   📤 Расход: ${expenseCount} записей\n`;
            msg += `   💵 Погашения: ${paymentsCount} записей\n\n`;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 Всего: *${years.length}* годов`;
        
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Управление ценами
bot.hears(/💰 Цены/i, async (ctx) => {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
        return ctx.reply('⛔ Доступ запрещён!');
    }
    
    await ctx.reply('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data) {
            return ctx.reply('❌ Не удалось получить данные');
        }
        
        const today = new Date().toISOString().split('T')[0];
        const prices = data.productPrices || {};
        
        let msg = `💰 *УПРАВЛЕНИЕ ЦЕНАМИ*\n${'═'.repeat(25)}\n\n`;
        
        // Показываем текущие цены на сегодня
        msg += `📅 *Цены на сегодня (${today}):*\n${'─'.repeat(20)}\n\n`;
        
        const todayPrices = prices[today];
        if (todayPrices && Object.keys(todayPrices).length > 0) {
            Object.entries(todayPrices).forEach(([product, groups]) => {
                msg += `📦 *${product}*\n`;
                Object.entries(groups).forEach(([group, priceList]) => {
                    if (priceList && priceList.length > 0) {
                        const lastPrice = priceList[priceList.length - 1];
                        const groupName = group === 'ALL' ? '🌍 Все склады' : `🏪 ${group}`;
                        msg += `   ${groupName}: *${formatNumber(lastPrice.price)} $* за тонну\n`;
                    }
                });
                msg += `\n`;
            });
        } else {
            msg += `_Цены на сегодня не установлены_\n\n`;
        }
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `\n💡 Для установки цены нажмите кнопку ниже`;
        
        // Сохраняем список товаров для выбора
        sessions[userId].priceProducts = data.products || [];
        sessions[userId].priceWarehouses = data.warehouses || [];
        saveSessions();
        
        const buttons = Markup.inlineKeyboard([
            [Markup.button.callback('➕ Установить цену', 'price_add')],
            [Markup.button.callback('📋 История цен', 'price_history')]
        ]);
        
        ctx.reply(msg, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Начало установки цены - выбор товара
bot.action('price_add', async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    await ctx.answerCbQuery();
    
    const products = session.priceProducts || [];
    
    if (products.length === 0) {
        return ctx.reply('❌ Список товаров пуст');
    }
    
    // Создаём кнопки для товаров (максимум 10)
    const buttons = products.slice(0, 10).map((product, i) => 
        [Markup.button.callback(`📦 ${product}`, `prprod_${i}`)]
    );
    buttons.push([Markup.button.callback('❌ Отмена', 'price_cancel')]);
    
    ctx.reply(
        `📦 *Выберите товар:*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
});

// Выбор товара для цены
bot.action(/^prprod_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    const productIndex = parseInt(ctx.match[1]);
    
    await ctx.answerCbQuery();
    
    const products = session.priceProducts || [];
    const product = products[productIndex];
    
    if (!product) {
        return ctx.reply('❌ Товар не найден');
    }
    
    // Сохраняем выбранный товар
    sessions[userId].selectedPriceProduct = product;
    saveSessions();
    
    // Получаем группы складов
    const warehouses = session.priceWarehouses || [];
    const groups = [...new Set(warehouses.map(w => w.group).filter(g => g))];
    
    // Создаём кнопки для групп
    const buttons = [
        [Markup.button.callback('🌍 Все склады (глобальная)', 'prgrp_ALL')]
    ];
    groups.slice(0, 8).forEach((group, i) => {
        buttons.push([Markup.button.callback(`🏪 ${group}`, `prgrp_${i}`)]);
    });
    buttons.push([Markup.button.callback('❌ Отмена', 'price_cancel')]);
    
    // Сохраняем группы
    sessions[userId].priceGroups = groups;
    saveSessions();
    
    ctx.reply(
        `📦 Товар: *${product}*\n\n🏪 *Выберите группу складов:*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
});

// Выбор группы складов
bot.action(/^prgrp_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    const groupParam = ctx.match[1];
    
    await ctx.answerCbQuery();
    
    let group;
    if (groupParam === 'ALL') {
        group = 'ALL';
    } else {
        const groupIndex = parseInt(groupParam);
        const groups = session.priceGroups || [];
        group = groups[groupIndex];
    }
    
    if (!group) {
        return ctx.reply('❌ Группа не найдена');
    }
    
    // Сохраняем выбранную группу
    sessions[userId].selectedPriceGroup = group;
    sessions[userId].waitingForPrice = true;
    saveSessions();
    
    const product = session.selectedPriceProduct;
    const groupName = group === 'ALL' ? 'Все склады' : group;
    
    ctx.reply(
        `📦 Товар: *${product}*\n🏪 Группа: *${groupName}*\n\n💰 *Введите цену за тонну (в $):*`,
        { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
    );
});

// Отмена установки цены
bot.action('price_cancel', async (ctx) => {
    const userId = ctx.from.id;
    
    sessions[userId].waitingForPrice = false;
    sessions[userId].selectedPriceProduct = null;
    sessions[userId].selectedPriceGroup = null;
    saveSessions();
    
    await ctx.answerCbQuery('Отменено');
    ctx.reply('❌ Установка цены отменена', managementKeyboard);
});

// История цен
bot.action('price_history', async (ctx) => {
    const userId = ctx.from.id;
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data || !data.productPrices) {
            return ctx.reply('📋 История цен пуста');
        }
        
        const prices = data.productPrices;
        const allEntries = [];
        
        // Собираем все записи
        Object.entries(prices).forEach(([date, products]) => {
            Object.entries(products).forEach(([product, groups]) => {
                Object.entries(groups).forEach(([group, priceList]) => {
                    priceList.forEach(entry => {
                        allEntries.push({
                            date,
                            product,
                            group: group === 'ALL' ? 'Все склады' : group,
                            price: entry.price,
                            user: entry.user || 'admin',
                            time: entry.time || ''
                        });
                    });
                });
            });
        });
        
        // Сортируем по дате (новые сверху)
        allEntries.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        if (allEntries.length === 0) {
            return ctx.reply('📋 История цен пуста');
        }
        
        let msg = `📋 *ИСТОРИЯ ЦЕН*\n${'═'.repeat(25)}\n\n`;
        
        // Показываем последние 20 записей
        allEntries.slice(0, 20).forEach((entry, i) => {
            msg += `${i + 1}. *${entry.date}* ${entry.time}\n`;
            msg += `   📦 ${entry.product}\n`;
            msg += `   🏪 ${entry.group}\n`;
            msg += `   💰 *${formatNumber(entry.price)} $* за тонну\n`;
            msg += `   👤 ${entry.user}\n\n`;
        });
        
        if (allEntries.length > 20) {
            msg += `_...и ещё ${allEntries.length - 20} записей_`;
        }
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (const part of parts) {
                await ctx.reply(part, { parse_mode: 'Markdown' });
            }
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// ==================== КОНЕЦ МЕНЮ УПРАВЛЕНИЯ ====================

// Приход за период
bot.hears(/📈|приход за период/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.income || yearData.income.length === 0) {
            return ctx.reply(`📈 Нет данных о приходе за ${year} год`);
        }
        
        // Группируем по месяцам
        const byMonth = {};
        yearData.income.filter(item => !item.isDeleted).forEach(item => {
            const date = new Date(item.date);
            const month = date.toLocaleString('ru', { month: 'long' });
            if (!byMonth[month]) byMonth[month] = { count: 0, tons: 0 };
            byMonth[month].count++;
            byMonth[month].tons += (item.qtyFact || 0) / 20;
        });
        
        let msg = `📈 *ПРИХОД ЗА ${year}*\n${'─'.repeat(20)}\n\n`;
        let totalTons = 0;
        let totalCount = 0;
        
        Object.entries(byMonth).forEach(([month, data]) => {
            msg += `📅 *${month}*: ${data.count} записей, ${formatNumber(data.tons)} т\n`;
            totalTons += data.tons;
            totalCount += data.count;
        });
        
        msg += `\n${'─'.repeat(20)}\n`;
        msg += `📊 Всего: *${totalCount}* записей\n`;
        msg += `📦 Итого: *${formatNumber(totalTons)} тонн*`;
        
        // Кнопка для детального отчёта
        const detailButton = Markup.inlineKeyboard([
            [Markup.button.callback('📋 Детальный за период', 'income_detail_menu')]
        ]);
        
        ctx.reply(msg, { parse_mode: 'Markdown', ...detailButton });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Меню выбора периода для детального прихода
bot.action('income_detail_menu', async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.answerCbQuery();
    
    const periodButtons = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Сегодня', 'incdet_today'), Markup.button.callback('📅 Вчера', 'incdet_yesterday')],
        [Markup.button.callback('📅 Эта неделя', 'incdet_week'), Markup.button.callback('📅 Этот месяц', 'incdet_month')],
        [Markup.button.callback('📅 Весь год', 'incdet_year')]
    ]);
    
    ctx.reply(
        `📋 *ДЕТАЛЬНЫЙ ПРИХОД*\n📅 Год: *${year}*\n\nВыберите период:`,
        { parse_mode: 'Markdown', ...periodButtons }
    );
});

// Обработка выбора периода для детального прихода
bot.action(/^incdet_(today|yesterday|week|month|year)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const periodType = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.income || yearData.income.length === 0) {
            return ctx.reply(`📈 Нет данных о приходе за ${year} год`);
        }
        
        // Определяем период
        const today = new Date();
        let dateFrom, dateTo, periodName;
        
        switch (periodType) {
            case 'today':
                dateFrom = new Date(today.toISOString().split('T')[0]);
                dateTo = new Date(today.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                dateFrom = new Date(yesterday.toISOString().split('T')[0]);
                dateTo = new Date(yesterday.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Вчера';
                break;
            case 'week':
                dateFrom = new Date(today);
                dateFrom.setDate(dateFrom.getDate() - 7);
                dateTo = today;
                periodName = 'За неделю';
                break;
            case 'month':
                dateFrom = new Date(today);
                dateFrom.setMonth(dateFrom.getMonth() - 1);
                dateTo = today;
                periodName = 'За месяц';
                break;
            case 'year':
                dateFrom = null;
                dateTo = null;
                periodName = `За ${year} год`;
                break;
        }
        
        // Фильтруем данные (исключаем удаленные записи)
        let income = yearData.income.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            income = income.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }
        
        if (income.length === 0) {
            return ctx.reply(`📈 Нет данных о приходе за выбранный период`);
        }
        
        // Формируем данные для отчёта
        const items = income.map(item => ({
            date: item.date || '',
            wagon: item.wagon || '',
            company: item.company || '',
            warehouse: item.warehouse || '',
            product: item.product || '',
            qtyDoc: parseFloat(item.qtyDoc) || 0,
            qtyFact: parseFloat(item.qtyFact) || 0,
            difference: (parseFloat(item.qtyFact) || 0) - (parseFloat(item.qtyDoc) || 0),
            weightTons: (parseFloat(item.qtyFact) || 0) / 20,
            notes: item.notes || ''
        }));
        
        // Сортируем по дате (новые сверху)
        items.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Итоги
        let totalDoc = 0, totalFact = 0, totalTons = 0;
        items.forEach(item => {
            totalDoc += item.qtyDoc;
            totalFact += item.qtyFact;
            totalTons += item.weightTons;
        });
        
        let msg = `📋 *ДЕТАЛЬНЫЙ ПРИХОД*\n`;
        msg += `📅 ${periodName}\n`;
        msg += `${'═'.repeat(25)}\n\n`;
        
        // Показываем до 15 записей
        const showItems = items.slice(0, 15);
        showItems.forEach((item, i) => {
            const formattedDate = new Date(item.date).toLocaleDateString('ru-RU');
            msg += `${i + 1}. *${formattedDate}*\n`;
            msg += `   🚂 ${item.wagon} | ${item.product}\n`;
            msg += `   ${item.company} → ${item.warehouse}\n`;
            msg += `   📄 ${item.qtyDoc} | ✅ ${item.qtyFact} | ⚖️ ${formatNumber(item.weightTons)} т\n\n`;
        });
        
        if (items.length > 15) {
            msg += `_...и ещё ${items.length - 15} записей_\n\n`;
        }
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *ИТОГО:* ${items.length} записей\n`;
        msg += `   📄 По док: *${totalDoc}* шт\n`;
        msg += `   ✅ Факт: *${totalFact}* шт\n`;
        msg += `   📈 Разница: *${totalFact - totalDoc}* шт\n`;
        msg += `   ⚖️ Вес: *${formatNumber(totalTons)} тонн*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastIncomeDetail = { items, periodName, year, totals: { doc: totalDoc, fact: totalFact, tons: totalTons } };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `exincdet_${periodType}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт детального прихода в Excel
bot.action(/^exincdet_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastIncomeDetail) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { items, periodName, year, totals } = session.lastIncomeDetail;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Детальный приход');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Вагон', key: 'wagon', width: 15 },
            { header: 'Фирма', key: 'company', width: 18 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Товар', key: 'product', width: 18 },
            { header: 'По док', key: 'qtyDoc', width: 10 },
            { header: 'Факт', key: 'qtyFact', width: 10 },
            { header: 'Разница', key: 'difference', width: 10 },
            { header: 'Вес (т)', key: 'weightTons', width: 10 },
            { header: 'Примечания', key: 'notes', width: 25 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // Данные
        items.forEach((item, i) => {
            sheet.addRow({
                num: i + 1,
                date: item.date,
                wagon: item.wagon,
                company: item.company,
                warehouse: item.warehouse,
                product: item.product,
                qtyDoc: item.qtyDoc,
                qtyFact: item.qtyFact,
                difference: item.difference,
                weightTons: item.weightTons,
                notes: item.notes
            });
        });
        
        // Итоговая строка
        const totalRow = sheet.addRow({
            num: '',
            date: '',
            wagon: '',
            company: '',
            warehouse: '',
            product: 'ИТОГО:',
            qtyDoc: totals.doc,
            qtyFact: totals.fact,
            difference: totals.fact - totals.doc,
            weightTons: totals.tons,
            notes: ''
        });
        totalRow.font = { bold: true };
        totalRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEEEEEE' }
        };
        
        // Сохраняем файл
        const fileName = `Приход_детальный_${periodName.replace(/\s/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            { caption: `📋 Детальный приход\n📅 ${periodName}\n📊 ${items.length} записей\n⚖️ ${formatNumber(totals.tons)} тонн` }
        );
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Расход за период
bot.hears(/📉|расход за период/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.expense || yearData.expense.length === 0) {
            return ctx.reply(`📉 Нет данных о расходе за ${year} год`);
        }
        
        // Группируем по месяцам
        const byMonth = {};
        yearData.expense.filter(item => !item.isDeleted).forEach(item => {
            const date = new Date(item.date);
            const month = date.toLocaleString('ru', { month: 'long' });
            if (!byMonth[month]) byMonth[month] = { count: 0, tons: 0, sum: 0 };
            byMonth[month].count++;
            byMonth[month].tons += (item.quantity || 0) / 20;
            byMonth[month].sum += item.total || 0;
        });
        
        let msg = `📉 *РАСХОД ЗА ${year}*\n${'─'.repeat(20)}\n\n`;
        let totalTons = 0;
        let totalSum = 0;
        let totalCount = 0;
        
        Object.entries(byMonth).forEach(([month, data]) => {
            msg += `📅 *${month}*\n`;
            msg += `   ${data.count} продаж, ${formatNumber(data.tons)} т\n`;
            msg += `   💵 ${formatNumber(data.sum)} $\n\n`;
            totalTons += data.tons;
            totalSum += data.sum;
            totalCount += data.count;
        });
        
        msg += `${'─'.repeat(20)}\n`;
        msg += `📊 Всего: *${totalCount}* продаж\n`;
        msg += `📦 Итого: *${formatNumber(totalTons)} тонн*\n`;
        msg += `💰 Сумма: *${formatNumber(totalSum)} $*`;
        
        // Кнопка для детального отчёта
        const detailButton = Markup.inlineKeyboard([
            [Markup.button.callback('📋 Детальный за период', 'expense_detail_menu')]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...detailButton });
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown', ...detailButton });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Меню выбора периода для детального расхода
bot.action('expense_detail_menu', async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.answerCbQuery();
    
    const periodButtons = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Сегодня', 'expdet_today'), Markup.button.callback('📅 Вчера', 'expdet_yesterday')],
        [Markup.button.callback('📅 Эта неделя', 'expdet_week'), Markup.button.callback('📅 Этот месяц', 'expdet_month')],
        [Markup.button.callback('📅 Весь год', 'expdet_year')]
    ]);
    
    ctx.reply(
        `📋 *ДЕТАЛЬНЫЙ РАСХОД*\n📅 Год: *${year}*\n\nВыберите период:`,
        { parse_mode: 'Markdown', ...periodButtons }
    );
});

// Обработка выбора периода для детального расхода
bot.action(/^expdet_(today|yesterday|week|month|year)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const periodType = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.expense || yearData.expense.length === 0) {
            return ctx.reply(`📉 Нет данных о расходе за ${year} год`);
        }
        
        // Определяем период
        const today = new Date();
        let dateFrom, dateTo, periodName;
        
        switch (periodType) {
            case 'today':
                dateFrom = new Date(today.toISOString().split('T')[0]);
                dateTo = new Date(today.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                dateFrom = new Date(yesterday.toISOString().split('T')[0]);
                dateTo = new Date(yesterday.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Вчера';
                break;
            case 'week':
                dateFrom = new Date(today);
                dateFrom.setDate(dateFrom.getDate() - 7);
                dateTo = today;
                periodName = 'За неделю';
                break;
            case 'month':
                dateFrom = new Date(today);
                dateFrom.setMonth(dateFrom.getMonth() - 1);
                dateTo = today;
                periodName = 'За месяц';
                break;
            case 'year':
                dateFrom = null;
                dateTo = null;
                periodName = `За ${year} год`;
                break;
        }
        
        // Фильтруем данные (исключаем удаленные записи)
        let expense = yearData.expense.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            expense = expense.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }
        
        if (expense.length === 0) {
            return ctx.reply(`📉 Нет данных о расходе за выбранный период`);
        }
        
        // Формируем данные для отчёта
        const items = expense.map(item => ({
            date: item.date || '',
            client: item.client || '',
            product: item.product || '',
            company: item.company || '',
            warehouse: item.warehouse || '',
            quantity: parseFloat(item.quantity) || 0,
            tons: (parseFloat(item.quantity) || 0) / 20,
            price: parseFloat(item.price) || 0,
            total: parseFloat(item.total) || 0,
            notes: item.notes || ''
        }));
        
        // Сортируем по дате (новые сверху)
        items.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Итоги
        let totalQty = 0, totalTons = 0, totalSum = 0;
        items.forEach(item => {
            totalQty += item.quantity;
            totalTons += item.tons;
            totalSum += item.total;
        });
        
        let msg = `📋 *ДЕТАЛЬНЫЙ РАСХОД*\n`;
        msg += `📅 ${periodName}\n`;
        msg += `${'═'.repeat(25)}\n\n`;
        
        // Показываем до 15 записей
        const showItems = items.slice(0, 15);
        showItems.forEach((item, i) => {
            const formattedDate = new Date(item.date).toLocaleDateString('ru-RU');
            msg += `${i + 1}. *${formattedDate}*\n`;
            msg += `   👤 ${item.client}\n`;
            msg += `   ${item.product} | ${item.warehouse}\n`;
            msg += `   📦 ${item.quantity} шт | ⚖️ ${formatNumber(item.tons)} т\n`;
            msg += `   💵 *${formatNumber(item.total)} $*\n\n`;
        });
        
        if (items.length > 15) {
            msg += `_...и ещё ${items.length - 15} записей_\n\n`;
        }
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *ИТОГО:* ${items.length} записей\n`;
        msg += `   📦 Количество: *${totalQty}* шт\n`;
        msg += `   ⚖️ Вес: *${formatNumber(totalTons)} тонн*\n`;
        msg += `   💰 Сумма: *${formatNumber(totalSum)} $*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastExpenseDetail = { items, periodName, year, totals: { qty: totalQty, tons: totalTons, sum: totalSum } };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `exexpdet_${periodType}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт детального расхода в Excel
bot.action(/^exexpdet_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastExpenseDetail) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { items, periodName, year, totals } = session.lastExpenseDetail;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Детальный расход');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Клиент', key: 'client', width: 20 },
            { header: 'Товар', key: 'product', width: 15 },
            { header: 'Фирма', key: 'company', width: 15 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Кол-во', key: 'quantity', width: 10 },
            { header: 'Тонны', key: 'tons', width: 10 },
            { header: 'Цена', key: 'price', width: 10 },
            { header: 'Сумма', key: 'total', width: 12 },
            { header: 'Примечания', key: 'notes', width: 20 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFF5722' }
        };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // Данные
        items.forEach((item, i) => {
            sheet.addRow({
                num: i + 1,
                date: item.date,
                client: item.client,
                product: item.product,
                company: item.company,
                warehouse: item.warehouse,
                quantity: item.quantity,
                tons: item.tons,
                price: item.price,
                total: item.total,
                notes: item.notes
            });
        });
        
        // Итоговая строка
        const totalRow = sheet.addRow({
            num: '',
            date: '',
            client: '',
            product: '',
            company: '',
            warehouse: 'ИТОГО:',
            quantity: totals.qty,
            tons: totals.tons,
            price: '',
            total: totals.sum,
            notes: ''
        });
        totalRow.font = { bold: true };
        totalRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEEEEEE' }
        };
        
        // Сохраняем файл
        const fileName = `Расход_детальный_${periodName.replace(/\s/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            { caption: `📋 Детальный расход\n📅 ${periodName}\n📊 ${items.length} записей\n💰 ${formatNumber(totals.sum)} $` }
        );
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Погашения за период
bot.hears(/💵|погашения за период/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.payments || yearData.payments.length === 0) {
            return ctx.reply(`� Нет данных о погашениях за ${year} год`);
        }
        
        // Группируем по месяцам
        const byMonth = {};
        yearData.payments.filter(item => !item.isDeleted).forEach(item => {
            const date = new Date(item.date);
            const month = date.toLocaleString('ru', { month: 'long' });
            if (!byMonth[month]) byMonth[month] = { count: 0, sum: 0 };
            byMonth[month].count++;
            byMonth[month].sum += item.amount || 0;
        });
        
        let msg = `💵 *ПОГАШЕНИЯ ЗА ${year}*\n${'─'.repeat(20)}\n\n`;
        let totalSum = 0;
        let totalCount = 0;
        
        Object.entries(byMonth).forEach(([month, data]) => {
            msg += `📅 *${month}*: ${data.count} платежей, ${formatNumber(data.sum)} $\n`;
            totalSum += data.sum;
            totalCount += data.count;
        });
        
        msg += `\n${'─'.repeat(20)}\n`;
        msg += `📊 Всего: *${totalCount}* платежей\n`;
        msg += `💰 Итого: *${formatNumber(totalSum)} $*`;
        
        // Кнопка для детального отчёта
        const detailButton = Markup.inlineKeyboard([
            [Markup.button.callback('📋 Детальный за период', 'payments_detail_menu')]
        ]);
        
        ctx.reply(msg, { parse_mode: 'Markdown', ...detailButton });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Меню выбора периода для детальных погашений
bot.action('payments_detail_menu', async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.answerCbQuery();
    
    const periodButtons = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Сегодня', 'paydet_today'), Markup.button.callback('📅 Вчера', 'paydet_yesterday')],
        [Markup.button.callback('📅 Эта неделя', 'paydet_week'), Markup.button.callback('📅 Этот месяц', 'paydet_month')],
        [Markup.button.callback('📅 Весь год', 'paydet_year')]
    ]);
    
    ctx.reply(
        `📋 *ДЕТАЛЬНЫЕ ПОГАШЕНИЯ*\n📅 Год: *${year}*\n\nВыберите период:`,
        { parse_mode: 'Markdown', ...periodButtons }
    );
});

// Обработка выбора периода для детальных погашений
bot.action(/^paydet_(today|yesterday|week|month|year)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const periodType = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.payments || yearData.payments.length === 0) {
            return ctx.reply(`💵 Нет данных о погашениях за ${year} год`);
        }
        
        // Определяем период
        const today = new Date();
        let dateFrom, dateTo, periodName;
        
        switch (periodType) {
            case 'today':
                dateFrom = new Date(today.toISOString().split('T')[0]);
                dateTo = new Date(today.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                dateFrom = new Date(yesterday.toISOString().split('T')[0]);
                dateTo = new Date(yesterday.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Вчера';
                break;
            case 'week':
                dateFrom = new Date(today);
                dateFrom.setDate(dateFrom.getDate() - 7);
                dateTo = today;
                periodName = 'За неделю';
                break;
            case 'month':
                dateFrom = new Date(today);
                dateFrom.setMonth(dateFrom.getMonth() - 1);
                dateTo = today;
                periodName = 'За месяц';
                break;
            case 'year':
                dateFrom = null;
                dateTo = null;
                periodName = `За ${year} год`;
                break;
        }
        
        // Фильтруем данные (исключаем удаленные записи)
        let payments = yearData.payments.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            payments = payments.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }
        
        if (payments.length === 0) {
            return ctx.reply(`💵 Нет погашений за выбранный период`);
        }
        
        // Формируем данные для отчёта
        const items = payments.map(item => ({
            date: item.date || '',
            client: item.client || '',
            amount: parseFloat(item.amount) || 0,
            notes: item.notes || item.note || '',
            user: item.user || ''
        }));
        
        // Сортируем по дате (новые сверху)
        items.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Итоги
        let totalSum = 0;
        items.forEach(item => {
            totalSum += item.amount;
        });
        
        // Группируем по клиентам для статистики
        const byClient = {};
        items.forEach(item => {
            if (!byClient[item.client]) byClient[item.client] = 0;
            byClient[item.client] += item.amount;
        });
        
        let msg = `📋 *ДЕТАЛЬНЫЕ ПОГАШЕНИЯ*\n`;
        msg += `📅 ${periodName}\n`;
        msg += `${'═'.repeat(25)}\n\n`;
        
        // Показываем до 20 записей
        const showItems = items.slice(0, 20);
        showItems.forEach((item, i) => {
            const formattedDate = new Date(item.date).toLocaleDateString('ru-RU');
            msg += `${i + 1}. *${formattedDate}*\n`;
            msg += `   👤 ${item.client}\n`;
            msg += `   💵 *${formatNumber(item.amount)} $*\n`;
            if (item.notes) {
                msg += `   📝 ${item.notes}\n`;
            }
            msg += `\n`;
        });
        
        if (items.length > 20) {
            msg += `_...и ещё ${items.length - 20} записей_\n\n`;
        }
        
        // Топ клиентов по погашениям
        const topClients = Object.entries(byClient)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        if (topClients.length > 0) {
            msg += `${'─'.repeat(20)}\n`;
            msg += `👥 *Топ по погашениям:*\n`;
            topClients.forEach(([client, sum], i) => {
                msg += `   ${i + 1}. ${client}: *${formatNumber(sum)} $*\n`;
            });
            msg += `\n`;
        }
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *ИТОГО:* ${items.length} платежей\n`;
        msg += `💰 Сумма: *${formatNumber(totalSum)} $*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastPaymentsDetail = { items, periodName, year, totalSum };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `expaydet_${periodType}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт детальных погашений в Excel
bot.action(/^expaydet_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastPaymentsDetail) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { items, periodName, year, totalSum } = session.lastPaymentsDetail;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Детальные погашения');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Клиент', key: 'client', width: 25 },
            { header: 'Сумма ($)', key: 'amount', width: 15 },
            { header: 'Примечания', key: 'notes', width: 30 },
            { header: 'Пользователь', key: 'user', width: 15 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF2196F3' }
        };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // Данные
        let total = 0;
        items.forEach((item, i) => {
            sheet.addRow({
                num: i + 1,
                date: item.date,
                client: item.client,
                amount: item.amount,
                notes: item.notes,
                user: item.user
            });
            total += item.amount;
        });
        
        // Итоговая строка
        const totalRow = sheet.addRow({
            num: '',
            date: '',
            client: 'ИТОГО:',
            amount: total,
            notes: '',
            user: ''
        });
        totalRow.font = { bold: true };
        totalRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEEEEEE' }
        };
        
        // Форматирование колонки суммы
        sheet.getColumn('amount').numFmt = '#,##0.00';
        
        // Сохраняем файл
        const fileName = `Погашения_детальный_${periodName.replace(/\s/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            { caption: `📋 Детальные погашения\n📅 ${periodName}\n📊 ${items.length} платежей\n💰 ${formatNumber(totalSum)} $` }
        );
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Топ должников
bot.hears(/👥|топ должников/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        const debts = calculateDebts(data, year);
        if (!debts || !Object.keys(debts).length) {
            return ctx.reply(`✅ Нет должников за ${year} год!`);
        }
        
        // Топ-10 должников
        const sorted = Object.entries(debts)
            .sort((a, b) => b[1].debt - a[1].debt)
            .slice(0, 10);
        
        let msg = `👥 *ТОП-10 ДОЛЖНИКОВ*\n📅 ${year}\n${'─'.repeat(20)}\n\n`;
        let totalDebt = 0;
        
        sorted.forEach(([client, d], i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            msg += `${medal} *${client}*\n`;
            msg += `   💳 Долг: *${formatNumber(d.debt)} $*\n\n`;
            totalDebt += d.debt;
        });
        
        const allDebts = Object.values(debts).reduce((sum, d) => sum + d.debt, 0);
        
        msg += `${'─'.repeat(20)}\n`;
        msg += `💰 Топ-10: *${formatNumber(totalDebt)} $*\n`;
        msg += `💰 Всего долгов: *${formatNumber(allDebts)} $*`;
        
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Итоги вагонов
bot.hears(/🚂|итоги вагонов/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка итогов вагонов...');
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const wagonTotals = calculateWagonTotals(data, year);
        
        if (!wagonTotals || wagonTotals.items.length === 0) {
            return ctx.reply(`🚂 Нет данных о вагонах за ${year} год`);
        }

        let msg = `🚂 *ИТОГИ ВАГОНОВ*\n📅 ${year}\n${'═'.repeat(25)}\n\n`;
        
        // Группируем по складам
        const byWarehouse = {};
        wagonTotals.items.forEach(item => {
            if (!byWarehouse[item.warehouse]) {
                byWarehouse[item.warehouse] = [];
            }
            byWarehouse[item.warehouse].push(item);
        });
        
        Object.entries(byWarehouse).sort().forEach(([warehouse, items]) => {
            msg += `🏪 *${warehouse}*\n`;
            msg += `${'─'.repeat(20)}\n`;
            
            let whWagons = 0, whDoc = 0, whFact = 0, whTons = 0;
            
            items.forEach(item => {
                msg += `📦 ${item.product} (${item.company})\n`;
                msg += `   🚂 Вагонов: ${item.wagons}\n`;
                msg += `   📄 По док: ${item.qtyDoc} шт\n`;
                msg += `   ✅ Факт: ${item.qtyFact} шт\n`;
                const diff = item.qtyFact - item.qtyDoc;
                const diffIcon = diff >= 0 ? '📈' : '📉';
                msg += `   ${diffIcon} Разница: ${diff} шт\n`;
                msg += `   ⚖️ Вес: ${formatNumber(item.weightTons)} т\n\n`;
                
                whWagons += item.wagons;
                whDoc += item.qtyDoc;
                whFact += item.qtyFact;
                whTons += item.weightTons;
            });
            
            msg += `📊 *Итого ${warehouse}:*\n`;
            msg += `   🚂 ${whWagons} вагонов, ⚖️ ${formatNumber(whTons)} т\n\n`;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `🚂 *ОБЩИЙ ИТОГ:*\n`;
        msg += `   Вагонов: *${wagonTotals.totals.wagons}*\n`;
        msg += `   По документам: *${wagonTotals.totals.qtyDoc}* шт\n`;
        msg += `   Фактически: *${wagonTotals.totals.qtyFact}* шт\n`;
        msg += `   Разница: *${wagonTotals.totals.difference}* шт\n`;
        msg += `   Вес: *${formatNumber(wagonTotals.totals.weightTons)} тонн*`;
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (const part of parts) {
                await ctx.reply(part, { parse_mode: 'Markdown' });
            }
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Расход по клиентам - выбор периода
bot.hears(/🛒|расход по клиентам/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    // Показываем кнопки выбора периода
    const periodButtons = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Сегодня', 'cexp_today')],
        [Markup.button.callback('📅 Вчера', 'cexp_yesterday')],
        [Markup.button.callback('📅 Эта неделя', 'cexp_week')],
        [Markup.button.callback('📅 Этот месяц', 'cexp_month')],
        [Markup.button.callback('📅 Весь год', 'cexp_year')]
    ]);
    
    ctx.reply(
        `🛒 *РАСХОД ПО КЛИЕНТАМ*\n📅 Год: *${year}*\n\nВыберите период:`,
        { parse_mode: 'Markdown', ...periodButtons }
    );
});

// Обработка выбора периода для расхода по клиентам
bot.action(/^cexp_(today|yesterday|week|month|year)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const period = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        // Определяем даты периода
        const today = new Date();
        let dateFrom, dateTo;
        let periodName;
        
        switch (period) {
            case 'today':
                dateFrom = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                dateTo = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
                periodName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                dateFrom = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
                dateTo = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59);
                periodName = 'Вчера';
                break;
            case 'week':
                const weekStart = new Date(today);
                weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
                dateFrom = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
                dateTo = today;
                periodName = 'Эта неделя';
                break;
            case 'month':
                dateFrom = new Date(today.getFullYear(), today.getMonth(), 1);
                dateTo = today;
                periodName = 'Этот месяц';
                break;
            case 'year':
                dateFrom = new Date(parseInt(year), 0, 1);
                dateTo = new Date(parseInt(year), 11, 31, 23, 59, 59);
                periodName = `Весь ${year} год`;
                break;
        }
        
        const reportData = calculateClientExpense(data, year, dateFrom, dateTo);
        
        if (!reportData || reportData.items.length === 0) {
            return ctx.reply(`🛒 Нет данных о расходах за период: ${periodName}`);
        }
        
        // Формируем сообщение
        let msg = `🛒 *РАСХОД ПО КЛИЕНТАМ*\n📅 ${periodName}\n${'═'.repeat(25)}\n\n`;
        
        // Группируем по клиентам
        const byClient = {};
        reportData.items.forEach(item => {
            if (!byClient[item.client]) {
                byClient[item.client] = { items: [], totalQty: 0, totalTons: 0, totalSum: 0 };
            }
            byClient[item.client].items.push(item);
            byClient[item.client].totalQty += item.quantity || 0;
            byClient[item.client].totalTons += item.tons || 0;
            byClient[item.client].totalSum += item.total || 0;
        });
        
        // Сортируем по сумме
        const sortedClients = Object.entries(byClient).sort((a, b) => b[1].totalSum - a[1].totalSum);
        
        sortedClients.forEach(([client, data]) => {
            msg += `👤 *${client}*\n`;
            msg += `   📦 ${data.totalQty} шт (${formatNumber(data.totalTons)} т)\n`;
            msg += `   💵 *${formatNumber(data.totalSum)} $*\n\n`;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *ИТОГО:*\n`;
        msg += `   📦 Количество: *${reportData.totals.quantity} шт*\n`;
        msg += `   ⚖️ Вес: *${formatNumber(reportData.totals.tons)} т*\n`;
        msg += `   💰 Сумма: *${formatNumber(reportData.totals.sum)} $*\n`;
        msg += `   👥 Клиентов: *${sortedClients.length}*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastClientExpense = { reportData, periodName, year };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `excexp_${period}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт расхода по клиентам в Excel
bot.action(/^excexp_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastClientExpense) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { reportData, periodName, year } = session.lastClientExpense;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Расход по клиентам');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Клиент', key: 'client', width: 20 },
            { header: 'Товар', key: 'product', width: 15 },
            { header: 'Фирма', key: 'company', width: 15 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Кол-во', key: 'quantity', width: 10 },
            { header: 'Тонны', key: 'tons', width: 10 },
            { header: 'Цена', key: 'price', width: 10 },
            { header: 'Сумма', key: 'total', width: 12 },
            { header: 'Примечания', key: 'notes', width: 20 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        
        // Данные
        reportData.items.forEach((item, i) => {
            sheet.addRow({
                num: i + 1,
                date: item.date,
                client: item.client,
                product: item.product,
                company: item.company,
                warehouse: item.warehouse,
                quantity: item.quantity,
                tons: item.tons,
                price: item.price,
                total: item.total,
                notes: item.notes || ''
            });
        });
        
        // Итоговая строка
        const lastRow = sheet.addRow({
            num: '',
            date: '',
            client: '',
            product: '',
            company: '',
            warehouse: 'ИТОГО:',
            quantity: reportData.totals.quantity,
            tons: reportData.totals.tons,
            price: '',
            total: reportData.totals.sum,
            notes: ''
        });
        lastRow.font = { bold: true };
        lastRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFF0B3' }
        };
        
        // Сохраняем файл
        const fileName = `Расход_по_клиентам_${periodName.replace(/\s/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument({ source: filePath, filename: fileName });
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Приход товаров - выбор периода
bot.hears(/� Приход товаров/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    ctx.reply(
        `📦 *ПРИХОД ТОВАРОВ*\n📅 Год: *${year}*\n\nВыберите период:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📅 Сегодня', 'incp_today'), Markup.button.callback('📅 Вчера', 'incp_yesterday')],
                [Markup.button.callback('📅 Неделя', 'incp_week'), Markup.button.callback('📅 Месяц', 'incp_month')],
                [Markup.button.callback('📅 Весь год', 'incp_year')]
            ])
        }
    );
});

// Обработка выбора периода для прихода товаров
bot.action(/^incp_(today|yesterday|week|month|year)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const periodType = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        const yearData = data?.years?.[year];
        if (!yearData || !yearData.income || yearData.income.length === 0) {
            return ctx.reply(`📦 Нет данных о приходе за ${year} год`);
        }
        
        // Определяем период
        const today = new Date();
        let dateFrom, dateTo, periodName;
        
        switch (periodType) {
            case 'today':
                dateFrom = new Date(today.toISOString().split('T')[0]);
                dateTo = new Date(today.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                dateFrom = new Date(yesterday.toISOString().split('T')[0]);
                dateTo = new Date(yesterday.toISOString().split('T')[0]);
                dateTo.setHours(23, 59, 59);
                periodName = 'Вчера';
                break;
            case 'week':
                dateFrom = new Date(today);
                dateFrom.setDate(dateFrom.getDate() - 7);
                dateTo = today;
                periodName = 'За неделю';
                break;
            case 'month':
                dateFrom = new Date(today);
                dateFrom.setMonth(dateFrom.getMonth() - 1);
                dateTo = today;
                periodName = 'За месяц';
                break;
            case 'year':
                dateFrom = null;
                dateTo = null;
                periodName = `За ${year} год`;
                break;
        }
        
        // Фильтруем данные
        let income = yearData.income;
        if (dateFrom && dateTo) {
            income = income.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }
        
        if (income.length === 0) {
            return ctx.reply(`📦 Нет данных о приходе за выбранный период`);
        }
        
        // Формируем данные для отчёта
        const items = income.map(item => ({
            date: item.date || '',
            wagon: item.wagon || '',
            company: item.company || '',
            warehouse: item.warehouse || '',
            product: item.product || '',
            qtyDoc: parseFloat(item.qtyDoc) || 0,
            qtyFact: parseFloat(item.qtyFact) || 0,
            difference: (parseFloat(item.qtyFact) || 0) - (parseFloat(item.qtyDoc) || 0),
            weightTons: (parseFloat(item.qtyFact) || 0) / 20,
            notes: item.notes || ''
        }));
        
        // Сортируем по дате (новые сверху)
        items.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Итоги
        let totalDoc = 0, totalFact = 0, totalTons = 0;
        items.forEach(item => {
            totalDoc += item.qtyDoc;
            totalFact += item.qtyFact;
            totalTons += item.weightTons;
        });
        
        let msg = `📦 *ПРИХОД ТОВАРОВ*\n`;
        msg += `📅 ${periodName}\n`;
        msg += `${'═'.repeat(25)}\n\n`;
        
        // Показываем до 15 записей
        const showItems = items.slice(0, 15);
        showItems.forEach((item, i) => {
            const formattedDate = new Date(item.date).toLocaleDateString('ru-RU');
            msg += `${i + 1}. *${formattedDate}*\n`;
            msg += `   🚂 ${item.wagon} | ${item.product}\n`;
            msg += `   ${item.company} → ${item.warehouse}\n`;
            msg += `   📄 ${item.qtyDoc} | ✅ ${item.qtyFact} | ⚖️ ${formatNumber(item.weightTons)} т\n\n`;
        });
        
        if (items.length > 15) {
            msg += `_...и ещё ${items.length - 15} записей_\n\n`;
        }
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *ИТОГО:* ${items.length} записей\n`;
        msg += `   📄 По док: *${totalDoc}* шт\n`;
        msg += `   ✅ Факт: *${totalFact}* шт\n`;
        msg += `   📈 Разница: *${totalFact - totalDoc}* шт\n`;
        msg += `   ⚖️ Вес: *${formatNumber(totalTons)} тонн*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastIncomeProducts = { items, periodName, year, totals: { doc: totalDoc, fact: totalFact, tons: totalTons } };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `exincp_${periodType}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт прихода товаров в Excel
bot.action(/^exincp_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastIncomeProducts) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { items, periodName, year, totals } = session.lastIncomeProducts;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Приход товаров');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Вагон', key: 'wagon', width: 15 },
            { header: 'Фирма', key: 'company', width: 18 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Товар', key: 'product', width: 18 },
            { header: 'По док', key: 'qtyDoc', width: 10 },
            { header: 'Факт', key: 'qtyFact', width: 10 },
            { header: 'Разница', key: 'difference', width: 10 },
            { header: 'Вес (т)', key: 'weightTons', width: 10 },
            { header: 'Примечания', key: 'notes', width: 25 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // Данные
        items.forEach((item, i) => {
            sheet.addRow({
                num: i + 1,
                date: item.date,
                wagon: item.wagon,
                company: item.company,
                warehouse: item.warehouse,
                product: item.product,
                qtyDoc: item.qtyDoc,
                qtyFact: item.qtyFact,
                difference: item.difference,
                weightTons: item.weightTons,
                notes: item.notes
            });
        });
        
        // Итоговая строка
        const totalRow = sheet.addRow({
            num: '',
            date: '',
            wagon: '',
            company: '',
            warehouse: '',
            product: 'ИТОГО:',
            qtyDoc: totals.doc,
            qtyFact: totals.fact,
            difference: totals.fact - totals.doc,
            weightTons: totals.tons,
            notes: ''
        });
        totalRow.font = { bold: true };
        totalRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEEEEEE' }
        };
        
        // Сохраняем файл
        const fileName = `Приход_товаров_${periodName.replace(/\s/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            { caption: `📦 Приход товаров\n📅 ${periodName}\n📊 ${items.length} записей\n⚖️ ${formatNumber(totals.tons)} тонн` }
        );
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Карточка клиента - выбор клиента
bot.hears(/👤|карточка клиента/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка списка клиентов...');
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        // Получаем список клиентов из разных источников
        let clientNames = [];
        
        // Если clients - массив
        if (Array.isArray(data.clients)) {
            data.clients.forEach(c => {
                if (typeof c === 'string') {
                    clientNames.push(c);
                } else if (c && c.name) {
                    clientNames.push(c.name);
                }
            });
        }
        // Если clients - объект
        else if (data.clients && typeof data.clients === 'object') {
            Object.values(data.clients).forEach(c => {
                if (typeof c === 'string') {
                    clientNames.push(c);
                } else if (c && c.name) {
                    clientNames.push(c.name);
                }
            });
        }
        
        // Также собираем клиентов из расходов
        const yearData = data?.years?.[year];
        if (yearData && yearData.expense) {
            yearData.expense.filter(e => !e.isDeleted).forEach(e => {
                if (e.client && !clientNames.includes(e.client)) {
                    clientNames.push(e.client);
                }
            });
        }
        
        // Сортируем и убираем дубликаты
        clientNames = [...new Set(clientNames)].sort();
        
        if (clientNames.length === 0) {
            return ctx.reply('👤 Нет клиентов в базе');
        }
        
        // Сохраняем маппинг клиентов по индексу
        sessions[userId].clientsList = clientNames;
        saveSessions();
        
        // Создаём inline кнопки для клиентов (максимум 50)
        const buttons = clientNames.slice(0, 50).map((client, index) => {
            const shortName = client.length > 25 ? client.substring(0, 22) + '...' : client;
            return [Markup.button.callback(`👤 ${shortName}`, `cl_${index}`)];
        });
        
        ctx.reply(
            `👤 *КАРТОЧКА КЛИЕНТА*\n📅 Год: *${year}*\n\nВыберите клиента (${clientNames.length}):`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }
        );
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Обработка выбора клиента
bot.action(/^cl_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const clientIndex = parseInt(ctx.match[1]);
    
    // Получаем имя клиента из списка
    const session = getSession(userId);
    const clientName = session.clientsList?.[clientIndex];
    
    if (!clientName) {
        return ctx.answerCbQuery('❌ Клиент не найден');
    }
    
    await ctx.answerCbQuery('⏳ Загрузка карточки...');
    
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные');
        
        const cardData = calculateClientCard(data, year, clientName);
        
        // Формируем текстовое сообщение
        let msg = `👤 *КАРТОЧКА КЛИЕНТА*\n`;
        msg += `📋 *${clientName}*\n`;
        msg += `📅 Год: *${year}*\n`;
        msg += `${'─'.repeat(25)}\n\n`;
        
        msg += `📊 *СВОДКА:*\n`;
        msg += `📦 Куплено: *${formatNumber(cardData.totalTons)} т*\n`;
        msg += `💵 Сумма покупок: *${formatNumber(cardData.totalSum)} $*\n`;
        msg += `✅ Оплачено: *${formatNumber(cardData.totalPaid)} $*\n`;
        msg += `💳 Остаток долга: *${formatNumber(cardData.debt)} $*\n\n`;
        
        if (cardData.purchases.length > 0) {
            msg += `${'─'.repeat(25)}\n`;
            msg += `📉 *ПОСЛЕДНИЕ ПОКУПКИ (до 10):*\n\n`;
            
            cardData.purchases.slice(0, 10).forEach((p, i) => {
                msg += `${i + 1}. ${p.date}\n`;
                msg += `   ${p.product} - ${formatNumber(p.tons)} т\n`;
                msg += `   💵 ${formatNumber(p.total)} $\n\n`;
            });
        }
        
        if (cardData.payments.length > 0) {
            msg += `${'─'.repeat(25)}\n`;
            msg += `💵 *ПОСЛЕДНИЕ ПЛАТЕЖИ (до 10):*\n\n`;
            
            cardData.payments.slice(0, 10).forEach((p, i) => {
                msg += `${i + 1}. ${p.date} - *${formatNumber(p.amount)} $*\n`;
            });
        }
        
        // Сохраняем данные для экспорта
        sessions[userId].lastClientCard = { clientName, cardData, year };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `excl_${clientIndex}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки карточки');
    }
});

// Экспорт карточки клиента в Excel
bot.action(/^excl_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastClientCard) {
        return ctx.answerCbQuery('❌ Сначала выберите клиента');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { clientName, cardData, year } = session.lastClientCard;
    
    try {
        const workbook = new ExcelJS.Workbook();
        
        // Лист 1: Сводка
        const summarySheet = workbook.addWorksheet('Сводка');
        summarySheet.columns = [
            { header: 'Параметр', key: 'param', width: 25 },
            { header: 'Значение', key: 'value', width: 20 }
        ];
        
        summarySheet.addRow({ param: 'КАРТОЧКА КЛИЕНТА', value: '' });
        summarySheet.addRow({ param: 'Клиент', value: clientName });
        summarySheet.addRow({ param: 'Год', value: year });
        summarySheet.addRow({ param: '', value: '' });
        summarySheet.addRow({ param: 'Куплено (тонн)', value: cardData.totalTons });
        summarySheet.addRow({ param: 'Сумма покупок ($)', value: cardData.totalSum });
        summarySheet.addRow({ param: 'Оплачено ($)', value: cardData.totalPaid });
        summarySheet.addRow({ param: 'Остаток долга ($)', value: cardData.debt });
        
        // Стиль заголовка
        summarySheet.getRow(1).font = { bold: true, size: 14 };
        
        // Лист 2: Покупки
        const purchasesSheet = workbook.addWorksheet('Покупки');
        purchasesSheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Товар', key: 'product', width: 20 },
            { header: 'Кол-во (мешки)', key: 'qty', width: 15 },
            { header: 'Тонны', key: 'tons', width: 10 },
            { header: 'Цена', key: 'price', width: 10 },
            { header: 'Сумма ($)', key: 'total', width: 12 }
        ];
        
        cardData.purchases.forEach((p, i) => {
            purchasesSheet.addRow({
                num: i + 1,
                date: p.date,
                warehouse: p.warehouse,
                product: p.product,
                qty: p.qty,
                tons: p.tons,
                price: p.price,
                total: p.total
            });
        });
        
        // Стиль заголовков
        purchasesSheet.getRow(1).font = { bold: true };
        purchasesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        
        // Лист 3: Платежи
        const paymentsSheet = workbook.addWorksheet('Платежи');
        paymentsSheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Сумма ($)', key: 'amount', width: 15 },
            { header: 'Примечание', key: 'note', width: 30 }
        ];
        
        cardData.payments.forEach((p, i) => {
            paymentsSheet.addRow({
                num: i + 1,
                date: p.date,
                amount: p.amount,
                note: p.note || ''
            });
        });
        
        paymentsSheet.getRow(1).font = { bold: true };
        paymentsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        
        // Сохраняем файл
        const fileName = `Карточка_${clientName.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}_${year}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument({ source: filePath, filename: fileName });
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Функция расчёта данных карточки клиента
function calculateClientCard(data, year, clientName) {
    const yearData = data?.years?.[year];
    if (!yearData) return { totalTons: 0, totalSum: 0, totalPaid: 0, debt: 0, purchases: [], payments: [] };
    
    const purchases = [];
    const payments = [];
    let totalTons = 0;
    let totalSum = 0;
    let totalPaid = 0;
    
    // Собираем покупки
    (yearData.expense || []).forEach(e => {
        if (e.client === clientName) {
            const tons = (e.quantity || 0) / 20;
            purchases.push({
                date: e.date || '',
                warehouse: e.warehouse || '',
                product: e.product || '',
                qty: e.quantity || 0,
                tons: tons,
                price: e.price || 0,
                total: e.total || 0
            });
            totalTons += tons;
            totalSum += e.total || 0;
        }
    });
    
    // Собираем платежи
    (yearData.payments || []).forEach(p => {
        if (p.client === clientName) {
            payments.push({
                date: p.date || '',
                amount: p.amount || 0,
                note: p.note || ''
            });
            totalPaid += p.amount || 0;
        }
    });
    
    // Сортируем по дате (новые первые)
    purchases.sort((a, b) => new Date(b.date) - new Date(a.date));
    payments.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return {
        totalTons,
        totalSum,
        totalPaid,
        debt: totalSum - totalPaid,
        purchases,
        payments
    };
}

// Остатки складов
bot.hears(/📦|\/stock|остатки складов/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные из базы');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const balances = calculateStock(data, year);
        if (!balances || !Object.keys(balances).length) return ctx.reply(`📦 Нет данных об остатках за ${year} год`);

        let msg = `📦 *ОСТАТКИ СКЛАДОВ*\n📅 ${year}\n${'─'.repeat(20)}\n\n`;
        let total = 0;

        Object.entries(balances).sort().forEach(([wh, items]) => {
            msg += `🏪 *${wh}*\n`;
            let whTotal = 0;
            items.forEach(i => {
                msg += `  ${i.company} ${i.product}: ${formatNumber(i.tons)} т\n`;
                whTotal += i.tons;
            });
            msg += `  _Итого: ${formatNumber(whTotal)} т_\n\n`;
            total += whTotal;
        });

        msg += `${'─'.repeat(20)}\n📊 *ИТОГО: ${formatNumber(total)} тонн*`;
        
        if (msg.length > 4000) {
            for (const part of msg.match(/[\s\S]{1,4000}/g)) await ctx.reply(part, { parse_mode: 'Markdown' });
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Фактический остаток (как в веб-приложении)
bot.hears(/🏭|фактический остаток/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка фактических остатков...');
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные из базы');
        
        const factBalance = calculateFactBalance(data, year);
        
        if (!factBalance || Object.keys(factBalance.warehouses).length === 0) {
            return ctx.reply(`🏭 Нет данных о фактических остатках за ${year} год`);
        }

        let msg = `🏭 *ФАКТИЧЕСКИЙ ОСТАТОК*\n📅 ${year}\n${'═'.repeat(25)}\n\n`;
        
        // Группируем по группам складов
        const groups = {};
        Object.entries(factBalance.warehouses).forEach(([whName, products]) => {
            const groupName = factBalance.warehouseGroups[whName] || 'Без группы';
            if (!groups[groupName]) groups[groupName] = {};
            groups[groupName][whName] = products;
        });
        
        let grandTotal = 0;
        
        // Выводим по группам
        Object.entries(groups).sort().forEach(([groupName, warehouses]) => {
            msg += `📁 *${groupName}*\n`;
            msg += `${'─'.repeat(20)}\n`;
            
            let groupTotal = 0;
            
            Object.entries(warehouses).sort().forEach(([whName, products]) => {
                msg += `🏪 *${whName}*\n`;
                let whTotal = 0;
                
                Object.entries(products).sort().forEach(([product, tons]) => {
                    if (tons !== 0) {
                        msg += `  • ${product}: ${formatNumber(tons)} т\n`;
                        whTotal += tons;
                    }
                });
                
                if (whTotal !== 0) {
                    msg += `  _Итого: ${formatNumber(whTotal)} т_\n`;
                }
                msg += `\n`;
                groupTotal += whTotal;
            });
            
            msg += `📊 *Итого ${groupName}: ${formatNumber(groupTotal)} т*\n\n`;
            grandTotal += groupTotal;
        });
        
        msg += `${'═'.repeat(25)}\n`;
        msg += `🏭 *ОБЩИЙ ИТОГ: ${formatNumber(grandTotal)} тонн*\n\n`;
        
        // Итоги по товарам
        if (Object.keys(factBalance.productTotals).length > 0) {
            msg += `📦 *ИТОГО ПО ТОВАРАМ:*\n`;
            Object.entries(factBalance.productTotals).sort().forEach(([product, tons]) => {
                if (tons !== 0) {
                    msg += `  • ${product}: ${formatNumber(tons)} т\n`;
                }
            });
        }
        
        // Добавляем раздел "Расход товаров" за сегодня
        const todayExpense = calculateTodayExpense(data, year);
        if (todayExpense && Object.keys(todayExpense).length > 0) {
            msg += `\n${'═'.repeat(25)}\n`;
            msg += `📤 *РАСХОД ТОВАРОВ*\n`;
            msg += `📅 ${new Date().toLocaleDateString('ru-RU')}\n`;
            msg += `${'─'.repeat(20)}\n`;
            
            Object.entries(todayExpense).sort().forEach(([product, tons]) => {
                if (tons > 0.01) {
                    msg += `  • ${product}: ${formatNumber(tons)} т/н (${year})\n`;
                }
            });
        }
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (const part of parts) {
                await ctx.reply(part, { parse_mode: 'Markdown' });
            }
        } else {
            ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Долги клиентов
bot.hears(/💰|\/debts|долги/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const data = await getData();
        if (!data) return ctx.reply('❌ Не удалось получить данные из базы');
        
        const debts = calculateDebts(data, year);
        if (!debts || !Object.keys(debts).length) return ctx.reply(`✅ Нет должников за ${year} год!`);

        let msg = `💰 *ДОЛГИ КЛИЕНТОВ*\n📅 ${year}\n${'─'.repeat(20)}\n\n`;
        let totalDebt = 0;

        const sorted = Object.entries(debts).sort((a, b) => b[1].debt - a[1].debt);
        
        // Показываем до 30 клиентов
        const showItems = sorted.slice(0, 30);
        showItems.forEach(([client, d], i) => {
            msg += `${i + 1}. *${client}*\n`;
            msg += `   Сумма: ${formatNumber(d.total)} $\n`;
            msg += `   Оплачено: ${formatNumber(d.paid)} $\n`;
            msg += `   💳 Долг: *${formatNumber(d.debt)} $*\n\n`;
            totalDebt += d.debt;
        });
        
        // Добавляем остальных в итог
        if (sorted.length > 30) {
            let restDebt = 0;
            sorted.slice(30).forEach(([_, d]) => {
                totalDebt += d.debt;
                restDebt += d.debt;
            });
            msg += `_...и ещё ${sorted.length - 30} клиентов на ${formatNumber(restDebt)} $_\n\n`;
        }

        msg += `${'─'.repeat(20)}\n👥 Должников: ${sorted.length}\n💰 *ИТОГО ДОЛГ: ${formatNumber(totalDebt)} $*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastDebtsReport = { 
            items: sorted.map(([client, d]) => ({ client, total: d.total, paid: d.paid, debt: d.debt })),
            year,
            totalDebt
        };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', 'exdebts')]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт долгов в Excel
bot.action('exdebts', async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastDebtsReport) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { items, year, totalDebt } = session.lastDebtsReport;
    
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Долги клиентов');
        
        // Заголовки
        sheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Клиент', key: 'client', width: 30 },
            { header: 'Сумма покупок ($)', key: 'total', width: 18 },
            { header: 'Оплачено ($)', key: 'paid', width: 15 },
            { header: 'Долг ($)', key: 'debt', width: 15 }
        ];
        
        // Стиль заголовков
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFF9800' }
        };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // Данные
        let sumTotal = 0, sumPaid = 0, sumDebt = 0;
        items.forEach((item, i) => {
            const row = sheet.addRow({
                num: i + 1,
                client: item.client,
                total: item.total,
                paid: item.paid,
                debt: item.debt
            });
            
            // Подсветка больших долгов
            if (item.debt > 10000) {
                row.getCell('debt').fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFCDD2' }
                };
            }
            
            sumTotal += item.total;
            sumPaid += item.paid;
            sumDebt += item.debt;
        });
        
        // Итоговая строка
        const totalRow = sheet.addRow({
            num: '',
            client: 'ИТОГО:',
            total: sumTotal,
            paid: sumPaid,
            debt: sumDebt
        });
        totalRow.font = { bold: true };
        totalRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEEEEEE' }
        };
        
        // Форматирование числовых колонок
        sheet.getColumn('total').numFmt = '#,##0.00';
        sheet.getColumn('paid').numFmt = '#,##0.00';
        sheet.getColumn('debt').numFmt = '#,##0.00';
        
        // Сохраняем файл
        const fileName = `debts_${year}_${Date.now()}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        await workbook.xlsx.writeFile(filePath);
        
        // Отправляем файл
        await ctx.replyWithDocument(
            { source: filePath, filename: `Долги_клиентов_${year}.xlsx` },
            { caption: `💰 Долги клиентов\n📅 ${year} год\n👥 ${items.length} должников\n💳 Итого долг: ${formatNumber(totalDebt)} $` }
        );
        
        // Удаляем временный файл
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Сводка
bot.hears(/📊|\/summary|сводка/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    await ctx.reply('⏳ Загрузка...');
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные из базы');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        const yearData = data?.years?.[year];
        if (!yearData) return ctx.reply(`📊 Нет данных за ${year} год`);

        let totalIncome = 0, totalExpense = 0, totalPaid = 0, totalSum = 0;
        
        // Фильтруем удаленные записи
        (yearData.income || []).filter(item => !item.isDeleted).forEach(i => totalIncome += (i.qtyFact || 0) / 20);
        (yearData.expense || []).filter(item => !item.isDeleted).forEach(e => {
            totalExpense += (e.quantity || 0) / 20;
            totalSum += e.total || 0;
        });
        (yearData.payments || []).filter(item => !item.isDeleted).forEach(p => totalPaid += p.amount || 0);

        const debts = calculateDebts(data, year);
        let totalDebt = 0, debtors = 0;
        if (debts) Object.values(debts).forEach(d => { totalDebt += d.debt; debtors++; });

        const stock = calculateStock(data, year);
        let totalStock = 0;
        if (stock) Object.values(stock).forEach(items => items.forEach(i => totalStock += i.tons));

        ctx.reply(
            `📊 *СВОДКА ЗА ${year}*\n${'─'.repeat(20)}\n\n` +
            `📥 Приход: *${formatNumber(totalIncome)} т*\n` +
            `📤 Расход: *${formatNumber(totalExpense)} т*\n` +
            `📦 Остаток: *${formatNumber(totalStock)} т*\n\n` +
            `${'─'.repeat(20)}\n` +
            `💵 Сумма продаж: *${formatNumber(totalSum)} $*\n` +
            `✅ Оплачено: *${formatNumber(totalPaid)} $*\n` +
            `💳 Общий долг: *${formatNumber(totalDebt)} $*\n` +
            `👥 Должников: *${debtors}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Отчёт за день - выбор даты
bot.hears(/📅 отчёт за день|отчет за день|\/daily/i, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    
    // Показываем кнопки выбора даты
    const dateButtons = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Сегодня', 'daily_today')],
        [Markup.button.callback('📅 Вчера', 'daily_yesterday')],
        [Markup.button.callback('📅 Позавчера', 'daily_2days')]
    ]);
    
    ctx.reply(
        `📅 *ОТЧЁТ ЗА ДЕНЬ*\n📆 Год: *${year}*\n\nВыберите дату:`,
        { parse_mode: 'Markdown', ...dateButtons }
    );
});

// Обработка выбора даты для отчёта за день
bot.action(/^daily_(today|yesterday|2days)$/, async (ctx) => {
    const userId = ctx.from.id;
    const year = getUserYear(userId);
    const dateType = ctx.match[1];
    
    await ctx.answerCbQuery('⏳ Загрузка...');
    
    try {
        const rawData = await getData();
        if (!rawData) return ctx.reply('❌ Не удалось получить данные');
        
        // Фильтруем данные по группам складов пользователя
        const data = filterDataByWarehouseGroup(rawData, userId);
        
        // Определяем дату
        const today = new Date();
        let reportDate;
        let dateName;
        
        switch (dateType) {
            case 'today':
                reportDate = today.toISOString().split('T')[0];
                dateName = 'Сегодня';
                break;
            case 'yesterday':
                const yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                reportDate = yesterday.toISOString().split('T')[0];
                dateName = 'Вчера';
                break;
            case '2days':
                const twoDays = new Date(today);
                twoDays.setDate(twoDays.getDate() - 2);
                reportDate = twoDays.toISOString().split('T')[0];
                dateName = 'Позавчера';
                break;
        }
        
        const dailyData = calculateDailyReport(data, year, reportDate);
        
        // Форматируем дату
        const formattedDate = new Date(reportDate).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
        
        let msg = `📅 *ОТЧЁТ ЗА ${formattedDate}*\n`;
        msg += `(${dateName})\n`;
        msg += `${'═'.repeat(25)}\n\n`;
        
        // ПРИХОД
        msg += `📦 *ПРИХОД ТОВАРОВ*\n`;
        msg += `${'─'.repeat(20)}\n`;
        
        if (dailyData.income.length > 0) {
            let incomeTotal = { doc: 0, fact: 0, tons: 0 };
            
            dailyData.income.forEach(item => {
                msg += `🚂 ${item.wagon || '-'} | ${item.product}\n`;
                msg += `   ${item.company} → ${item.warehouse}\n`;
                msg += `   📄 ${item.qtyDoc} | ✅ ${item.qtyFact} | ⚖️ ${formatNumber(item.weightTons)} т\n\n`;
                incomeTotal.doc += item.qtyDoc || 0;
                incomeTotal.fact += item.qtyFact || 0;
                incomeTotal.tons += item.weightTons || 0;
            });
            
            msg += `📊 *Итого приход:* ${dailyData.income.length} операций\n`;
            msg += `   📄 По док: ${incomeTotal.doc} | ✅ Факт: ${incomeTotal.fact}\n`;
            msg += `   ⚖️ Вес: *${formatNumber(incomeTotal.tons)} т*\n\n`;
        } else {
            msg += `_Операций прихода не было_\n\n`;
        }
        
        // РАСХОД
        msg += `📤 *РАСХОД ТОВАРОВ*\n`;
        msg += `${'─'.repeat(20)}\n`;
        
        if (dailyData.expense.length > 0) {
            let expenseTotal = { qty: 0, tons: 0, sum: 0 };
            
            dailyData.expense.forEach(item => {
                msg += `👤 ${item.client}\n`;
                msg += `   ${item.product} | ${item.warehouse}\n`;
                msg += `   📦 ${item.quantity} шт | ⚖️ ${formatNumber(item.tons)} т\n`;
                msg += `   💵 *${formatNumber(item.total)} $*\n\n`;
                expenseTotal.qty += item.quantity || 0;
                expenseTotal.tons += item.tons || 0;
                expenseTotal.sum += item.total || 0;
            });
            
            msg += `📊 *Итого расход:* ${dailyData.expense.length} операций\n`;
            msg += `   📦 ${expenseTotal.qty} шт | ⚖️ ${formatNumber(expenseTotal.tons)} т\n`;
            msg += `   💰 Сумма: *${formatNumber(expenseTotal.sum)} $*\n\n`;
        } else {
            msg += `_Операций расхода не было_\n\n`;
        }
        
        // СВОДКА
        msg += `${'═'.repeat(25)}\n`;
        msg += `📊 *СВОДКА ЗА ДЕНЬ:*\n`;
        msg += `   📦 Приход: ${dailyData.income.length} операций\n`;
        msg += `   📤 Расход: ${dailyData.expense.length} операций\n`;
        msg += `   💰 Сумма продаж: *${formatNumber(dailyData.totals.expenseSum)} $*`;
        
        // Сохраняем данные для экспорта
        sessions[userId].lastDailyReport = { dailyData, reportDate, formattedDate };
        saveSessions();
        
        // Кнопка экспорта
        const exportButton = Markup.inlineKeyboard([
            [Markup.button.callback('📊 Экспорт в Excel', `exdaily_${dateType}`)]
        ]);
        
        if (msg.length > 4000) {
            const parts = msg.match(/[\s\S]{1,4000}/g);
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.reply(parts[i], { parse_mode: 'Markdown' });
            }
            await ctx.reply(parts[parts.length - 1], { parse_mode: 'Markdown', ...exportButton });
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown', ...exportButton });
        }
        
    } catch (e) {
        console.error('Ошибка:', e);
        ctx.reply('❌ Ошибка загрузки данных');
    }
});

// Экспорт отчёта за день в Excel
bot.action(/^exdaily_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = getSession(userId);
    
    if (!session.lastDailyReport) {
        return ctx.answerCbQuery('❌ Сначала сформируйте отчёт');
    }
    
    await ctx.answerCbQuery('📊 Создание Excel файла...');
    
    const { dailyData, reportDate, formattedDate } = session.lastDailyReport;
    
    try {
        const workbook = new ExcelJS.Workbook();
        
        // Лист 1: Приход
        const incomeSheet = workbook.addWorksheet('Приход');
        incomeSheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Вагон', key: 'wagon', width: 15 },
            { header: 'Фирма', key: 'company', width: 15 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Товар', key: 'product', width: 15 },
            { header: 'По док', key: 'qtyDoc', width: 10 },
            { header: 'По факту', key: 'qtyFact', width: 10 },
            { header: 'Разница', key: 'diff', width: 10 },
            { header: 'Вес (т)', key: 'weight', width: 10 }
        ];
        
        incomeSheet.getRow(1).font = { bold: true };
        incomeSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
        
        let incTotalDoc = 0, incTotalFact = 0, incTotalWeight = 0;
        dailyData.income.forEach((item, i) => {
            incomeSheet.addRow({
                num: i + 1,
                date: item.date,
                wagon: item.wagon || '',
                company: item.company,
                warehouse: item.warehouse,
                product: item.product,
                qtyDoc: item.qtyDoc,
                qtyFact: item.qtyFact,
                diff: (item.qtyFact || 0) - (item.qtyDoc || 0),
                weight: item.weightTons
            });
            incTotalDoc += item.qtyDoc || 0;
            incTotalFact += item.qtyFact || 0;
            incTotalWeight += item.weightTons || 0;
        });
        
        const incLastRow = incomeSheet.addRow({
            num: '', date: '', wagon: '', company: '', warehouse: 'ИТОГО:',
            product: '', qtyDoc: incTotalDoc, qtyFact: incTotalFact,
            diff: incTotalFact - incTotalDoc, weight: incTotalWeight
        });
        incLastRow.font = { bold: true };
        incLastRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0B3' } };
        
        // Лист 2: Расход
        const expenseSheet = workbook.addWorksheet('Расход');
        expenseSheet.columns = [
            { header: '№', key: 'num', width: 5 },
            { header: 'Дата', key: 'date', width: 12 },
            { header: 'Клиент', key: 'client', width: 20 },
            { header: 'Фирма', key: 'company', width: 15 },
            { header: 'Склад', key: 'warehouse', width: 15 },
            { header: 'Товар', key: 'product', width: 15 },
            { header: 'Кол-во', key: 'quantity', width: 10 },
            { header: 'Тонны', key: 'tons', width: 10 },
            { header: 'Цена', key: 'price', width: 10 },
            { header: 'Сумма', key: 'total', width: 12 },
            { header: 'Примечания', key: 'notes', width: 20 }
        ];
        
        expenseSheet.getRow(1).font = { bold: true };
        expenseSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCB' } };
        
        let expTotalQty = 0, expTotalTons = 0, expTotalSum = 0;
        dailyData.expense.forEach((item, i) => {
            expenseSheet.addRow({
                num: i + 1,
                date: item.date,
                client: item.client,
                company: item.company,
                warehouse: item.warehouse,
                product: item.product,
                quantity: item.quantity,
                tons: item.tons,
                price: item.price,
                total: item.total,
                notes: item.notes || ''
            });
            expTotalQty += item.quantity || 0;
            expTotalTons += item.tons || 0;
            expTotalSum += item.total || 0;
        });
        
        const expLastRow = expenseSheet.addRow({
            num: '', date: '', client: '', company: '', warehouse: 'ИТОГО:',
            product: '', quantity: expTotalQty, tons: expTotalTons,
            price: '', total: expTotalSum, notes: ''
        });
        expLastRow.font = { bold: true };
        expLastRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0B3' } };
        
        // Сохраняем файл
        const fileName = `Отчет_за_${formattedDate.replace(/\./g, '-')}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        
        await workbook.xlsx.writeFile(filePath);
        await ctx.replyWithDocument({ source: filePath, filename: fileName });
        fs.unlinkSync(filePath);
        
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        ctx.reply('❌ Ошибка создания Excel файла');
    }
});

// Запуск бота
console.log('🔄 Подключение к Telegram API...');

(async () => {
    try {
        const botInfo = await bot.telegram.getMe();
        console.log(`✅ Бот подключен: @${botInfo.username}`);
        
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        bot.launch().catch(err => console.error('❌ Ошибка polling:', err.message));
        
        console.log('✅ Бот запущен!');
        console.log(`📱 Найдите @${botInfo.username} в Telegram`);
        console.log('');
        console.log('Для входа используйте логин/пароль из приложения Avesta');
        if (!firebaseDb) {
            console.log('');
            console.log('⚠️  Firebase Admin SDK не настроен!');
            console.log('    Для работы измените правила Firebase или добавьте');
            console.log('    файл firebase-service-account.json');
        }
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
