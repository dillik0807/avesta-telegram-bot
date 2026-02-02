/**
 * 📢 Модуль уведомлений о неактивных клиентах
 * Проверяет клиентов, которые не брали товар последние 7 дней
 */

// Функция для поиска клиентов, которые брали товар ровно N дней назад
const findClientsWithPurchaseOnDate = (data, year, daysAgo = 7) => {
    const yearData = data?.years?.[year];
    if (!yearData || !yearData.expense) return [];

    const today = new Date();
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() - daysAgo);
    const targetDateString = targetDate.toISOString().split('T')[0];

    console.log(`🔍 Ищем клиентов, которые покупали ${targetDateString} (${daysAgo} дней назад)`);

    // Собираем клиентов, которые покупали в указанную дату
    const clientsWithPurchases = [];
    
    // Фильтруем неудаленные записи расхода за указанную дату
    yearData.expense.filter(item => !item.isDeleted && item.date === targetDateString).forEach(expense => {
        if (!expense.client) return;
        
        clientsWithPurchases.push({
            client: expense.client,
            purchaseDate: expense.date,
            product: expense.product || '',
            warehouse: expense.warehouse || '',
            quantity: expense.quantity || 0,
            total: expense.total || 0,
            daysAgo: daysAgo
        });
    });

    console.log(`📋 Найдено ${clientsWithPurchases.length} покупок за ${targetDateString}`);
    
    return clientsWithPurchases;
};

// Функция для получения клиентов с долгами, которые покупали N дней назад
const findDebtorsWithPurchaseOnDate = (data, year, daysAgo = 7) => {
    const clientsWithPurchases = findClientsWithPurchaseOnDate(data, year, daysAgo);
    
    // Получаем информацию о долгах
    const debts = calculateDebts(data, year);
    if (!debts) return [];
    
    // Группируем по клиентам и добавляем информацию о долгах
    const clientGroups = {};
    
    clientsWithPurchases.forEach(purchase => {
        const clientName = purchase.client;
        
        if (!clientGroups[clientName]) {
            clientGroups[clientName] = {
                client: clientName,
                purchases: [],
                totalPurchaseAmount: 0,
                debt: 0,
                totalPurchases: 0,
                totalPaid: 0,
                daysAgo: daysAgo
            };
        }
        
        clientGroups[clientName].purchases.push(purchase);
        clientGroups[clientName].totalPurchaseAmount += purchase.total;
    });
    
    // Добавляем информацию о долгах и фильтруем только должников
    const debtorsWithPurchases = [];
    
    Object.values(clientGroups).forEach(clientGroup => {
        const debt = debts[clientGroup.client];
        
        if (debt && debt.debt > 0) {
            clientGroup.debt = debt.debt;
            clientGroup.totalPurchases = debt.total;
            clientGroup.totalPaid = debt.paid;
            
            debtorsWithPurchases.push(clientGroup);
        }
    });
    
    // Сортируем по размеру долга (больший долг первым)
    debtorsWithPurchases.sort((a, b) => b.debt - a.debt);
    
    console.log(`💳 Найдено ${debtorsWithPurchases.length} должников, которые покупали ${daysAgo} дней назад`);
    
    return debtorsWithPurchases;
};

// Функция расчёта долгов (копия из основного файла)
const calculateDebts = (data, year) => {
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

// Функция форматирования числа
const formatNumber = (num) => {
    return (num || 0).toFixed(2);
};

module.exports = {
    findClientsWithPurchaseOnDate,
    findDebtorsWithPurchaseOnDate,
    calculateDebts,
    formatNumber
};