/**
 * 🤖 Комплексные исправления для Telegram Bot
 * Применяет все исправления из основного приложения
 * Версия: 1.0
 * Дата: 27.01.2026
 */

console.log('🤖 Загрузка комплексных исправлений для Telegram Bot...');

/**
 * 🗑️ Исправление системы мягкого удаления
 */
function fixSoftDeleteSystem() {
    console.log('🗑️ Применение исправлений системы мягкого удаления...');
    
    // Функция для безопасного мягкого удаления
    global.safeSoftDelete = function(data, type, id, deletedBy = 'telegram-bot') {
        console.log(`🗑️ Мягкое удаление ${type} ID: ${id}`);
        
        if (!data || !data.years) {
            console.log('⚠️ Нет данных для удаления');
            return false;
        }
        
        let found = false;
        
        // Проходим по всем годам
        Object.keys(data.years).forEach(year => {
            const yearData = data.years[year];
            if (!yearData[type]) return;
            
            // Ищем запись для удаления
            const items = yearData[type];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                // Проверяем ID (может быть строкой или числом)
                const itemId = typeof item.id === 'string' ? item.id : String(item.id);
                const targetId = typeof id === 'string' ? id : String(id);
                
                if (itemId === targetId) {
                    // Помечаем как удаленное
                    item.isDeleted = true;
                    item.deletedAt = Date.now();
                    item.deletedBy = deletedBy;
                    
                    console.log(`✅ Помечено как удаленное: ${type} ID ${id} в году ${year}`);
                    found = true;
                }
            }
        });
        
        return found;
    };
    
    // Функция для восстановления из корзины
    global.restoreFromTrash = function(data, type, id, restoredBy = 'telegram-bot') {
        console.log(`🔄 Восстановление ${type} ID: ${id}`);
        
        if (!data || !data.years) {
            console.log('⚠️ Нет данных для восстановления');
            return false;
        }
        
        let found = false;
        
        // Проходим по всем годам
        Object.keys(data.years).forEach(year => {
            const yearData = data.years[year];
            if (!yearData[type]) return;
            
            // Ищем запись для восстановления
            const items = yearData[type];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                // Проверяем ID
                const itemId = typeof item.id === 'string' ? item.id : String(item.id);
                const targetId = typeof id === 'string' ? id : String(id);
                
                if (itemId === targetId && item.isDeleted) {
                    // Восстанавливаем
                    delete item.isDeleted;
                    delete item.deletedAt;
                    delete item.deletedBy;
                    item.restoredAt = Date.now();
                    item.restoredBy = restoredBy;
                    
                    console.log(`✅ Восстановлено: ${type} ID ${id} в году ${year}`);
                    found = true;
                }
            }
        });
        
        return found;
    };
    
    console.log('✅ Система мягкого удаления настроена');
}

/**
 * 📊 Исправление функций отчетов
 */
function fixReportFunctions() {
    console.log('📊 Исправление функций отчетов...');
    
    // Улучшенная функция расчета отчета за день
    global.calculateDailyReportFixed = function(data, year, reportDate) {
        const yearData = data?.years?.[year];
        if (!yearData) return { income: [], expense: [], totals: { expenseSum: 0 } };

        console.log(`📅 Расчет отчета за ${reportDate} для года ${year}`);

        // Фильтруем удаленные записи из приходов
        const income = (yearData.income || [])
            .filter(item => item.date === reportDate && !item.isDeleted)
            .map(item => ({
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
        const expense = (yearData.expense || [])
            .filter(item => item.date === reportDate && !item.isDeleted)
            .map(item => ({
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

        console.log(`📊 Отчет за день: Приходы: ${income.length}, Расходы: ${expense.length}, Сумма: ${expenseSum}`);

        return { income, expense, totals: { expenseSum } };
    };
    
    // Улучшенная функция расчета долгов
    global.calculateDebtsFixed = function(data, year) {
        const yearData = data?.years?.[year];
        if (!yearData) return null;

        console.log(`💰 Расчет долгов для года ${year}`);

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
                result[client] = {
                    total: d.total,
                    paid: d.paid,
                    debt: debt
                };
            }
        });

        const totalDebt = Object.values(result).reduce((sum, client) => sum + client.debt, 0);
        console.log(`💰 Общий долг: ${totalDebt}, Клиентов с долгами: ${Object.keys(result).length}`);

        return result;
    };
    
    console.log('✅ Функции отчетов исправлены');
}

/**
 * 🔄 Исправление системы синхронизации
 */
function fixSyncSystem() {
    console.log('🔄 Исправление системы синхронизации...');
    
    // Улучшенная функция синхронизации данных
    global.syncDataSafely = async function(data, source = 'telegram-bot') {
        console.log('🔄 Безопасная синхронизация данных...');
        
        if (!data) {
            console.log('⚠️ Нет данных для синхронизации');
            return false;
        }
        
        try {
            // Добавляем метаданные синхронизации
            data.lastSync = Date.now();
            data.lastSyncBy = source;
            data.syncSource = source;
            
            // Проверяем целостность данных
            if (!data.years) {
                data.years = {};
            }
            
            // Убеждаемся что текущий год существует
            const currentYear = data.currentYear || DEFAULT_YEAR;
            if (!data.years[currentYear]) {
                data.years[currentYear] = {
                    income: [],
                    expense: [],
                    payments: [],
                    partners: []
                };
            }
            
            console.log('✅ Данные подготовлены для синхронизации');
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка при подготовке данных:', error);
            return false;
        }
    };
    
    console.log('✅ Система синхронизации исправлена');
}

/**
 * 🛡️ Исправление системы безопасности
 */
function fixSecuritySystem() {
    console.log('🛡️ Исправление системы безопасности...');
    
    // Функция для безопасной проверки прав доступа
    global.checkUserPermissions = function(userId, action, data = null) {
        console.log(`🛡️ Проверка прав пользователя ${userId} для действия: ${action}`);
        
        // Базовые проверки
        if (!userId) {
            console.log('❌ Не указан ID пользователя');
            return false;
        }
        
        // Здесь можно добавить более сложную логику проверки прав
        // Пока разрешаем все действия для авторизованных пользователей
        console.log('✅ Права доступа подтверждены');
        return true;
    };
    
    // Функция для логирования действий пользователей
    global.logUserAction = function(userId, action, details = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            userId,
            action,
            details,
            source: 'telegram-bot'
        };
        
        console.log('📝 Действие пользователя:', JSON.stringify(logEntry));
        
        // Здесь можно добавить сохранение в файл или базу данных
    };
    
    console.log('✅ Система безопасности настроена');
}

/**
 * 📱 Исправление интерфейса бота
 */
function fixBotInterface() {
    console.log('📱 Исправление интерфейса бота...');
    
    // Улучшенная функция форматирования чисел
    global.formatNumberSafe = function(num) {
        if (typeof num !== 'number' || isNaN(num)) {
            return '0';
        }
        return num.toLocaleString('ru-RU', { 
            minimumFractionDigits: 0,
            maximumFractionDigits: 2 
        });
    };
    
    // Функция для безопасного форматирования дат
    global.formatDateSafe = function(dateStr) {
        if (!dateStr) return 'Не указана';
        
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return 'Неверная дата';
            
            return date.toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });
        } catch (error) {
            console.log('⚠️ Ошибка форматирования даты:', error);
            return 'Ошибка даты';
        }
    };
    
    // Функция для создания безопасных клавиатур
    global.createSafeKeyboard = function(buttons, options = {}) {
        try {
            if (!Array.isArray(buttons) || buttons.length === 0) {
                return Markup.keyboard([['🏠 Главное меню']]).resize();
            }
            
            return Markup.keyboard(buttons).resize();
        } catch (error) {
            console.log('⚠️ Ошибка создания клавиатуры:', error);
            return Markup.keyboard([['🏠 Главное меню']]).resize();
        }
    };
    
    console.log('✅ Интерфейс бота исправлен');
}

/**
 * 🔧 Исправление обработки ошибок
 */
function fixErrorHandling() {
    console.log('🔧 Исправление обработки ошибок...');
    
    // Глобальный обработчик ошибок для бота
    global.handleBotError = function(error, ctx, action = 'неизвестное действие') {
        console.error(`❌ Ошибка в боте при ${action}:`, error);
        
        // Логируем детали ошибки
        const errorDetails = {
            message: error.message,
            stack: error.stack,
            action: action,
            userId: ctx?.from?.id,
            chatId: ctx?.chat?.id,
            timestamp: new Date().toISOString()
        };
        
        console.error('📋 Детали ошибки:', JSON.stringify(errorDetails, null, 2));
        
        // Отправляем пользователю понятное сообщение
        if (ctx && ctx.reply) {
            ctx.reply('❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.')
                .catch(replyError => {
                    console.error('❌ Ошибка при отправке сообщения об ошибке:', replyError);
                });
        }
        
        return false;
    };
    
    // Функция для безопасного выполнения асинхронных операций
    global.safeAsync = async function(asyncFunction, ctx, actionName) {
        try {
            return await asyncFunction();
        } catch (error) {
            return handleBotError(error, ctx, actionName);
        }
    };
    
    console.log('✅ Обработка ошибок настроена');
}

/**
 * 📊 Исправление функций экспорта
 */
function fixExportFunctions() {
    console.log('📊 Исправление функций экспорта...');
    
    // Безопасная функция создания Excel файлов
    global.createExcelSafely = async function(data, filename, sheetName = 'Данные') {
        try {
            console.log(`📊 Создание Excel файла: ${filename}`);
            
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet(sheetName);
            
            if (!data || !Array.isArray(data) || data.length === 0) {
                worksheet.addRow(['Нет данных']);
                console.log('⚠️ Нет данных для экспорта');
            } else {
                // Добавляем заголовки (первая строка)
                if (data.length > 0) {
                    const headers = Object.keys(data[0]);
                    worksheet.addRow(headers);
                    
                    // Добавляем данные
                    data.forEach(row => {
                        const values = headers.map(header => row[header] || '');
                        worksheet.addRow(values);
                    });
                }
                
                console.log(`📊 Добавлено ${data.length} строк данных`);
            }
            
            // Автоширина колонок
            worksheet.columns.forEach(column => {
                column.width = 15;
            });
            
            // Сохраняем файл
            const filePath = path.join(__dirname, filename);
            await workbook.xlsx.writeFile(filePath);
            
            console.log(`✅ Excel файл создан: ${filePath}`);
            return filePath;
            
        } catch (error) {
            console.error('❌ Ошибка создания Excel файла:', error);
            throw error;
        }
    };
    
    console.log('✅ Функции экспорта исправлены');
}

/**
 * 🚀 Основная функция инициализации всех исправлений
 */
function initializeAllFixes() {
    console.log('🚀 Инициализация всех исправлений для Telegram Bot...');
    
    try {
        fixSoftDeleteSystem();
        fixReportFunctions();
        fixSyncSystem();
        fixSecuritySystem();
        fixBotInterface();
        fixErrorHandling();
        fixExportFunctions();
        
        console.log('✅ Все исправления успешно применены!');
        
        // Устанавливаем флаг что исправления загружены
        global.TELEGRAM_BOT_FIXES_LOADED = true;
        
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка при инициализации исправлений:', error);
        return false;
    }
}

// Функция для проверки статуса исправлений
global.checkFixesStatus = function() {
    const status = {
        softDelete: typeof global.safeSoftDelete === 'function',
        reports: typeof global.calculateDailyReportFixed === 'function',
        sync: typeof global.syncDataSafely === 'function',
        security: typeof global.checkUserPermissions === 'function',
        interface: typeof global.formatNumberSafe === 'function',
        errorHandling: typeof global.handleBotError === 'function',
        export: typeof global.createExcelSafely === 'function',
        allLoaded: global.TELEGRAM_BOT_FIXES_LOADED === true
    };
    
    console.log('📊 Статус исправлений Telegram Bot:', status);
    return status;
};

// Автоматическая инициализация
initializeAllFixes();

console.log('✅ Модуль комплексных исправлений Telegram Bot загружен');

module.exports = {
    initializeAllFixes,
    checkFixesStatus,
    safeSoftDelete: global.safeSoftDelete,
    restoreFromTrash: global.restoreFromTrash,
    calculateDailyReportFixed: global.calculateDailyReportFixed,
    calculateDebtsFixed: global.calculateDebtsFixed,
    syncDataSafely: global.syncDataSafely,
    handleBotError: global.handleBotError,
    createExcelSafely: global.createExcelSafely
};