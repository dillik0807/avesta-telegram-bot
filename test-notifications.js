/**
 * 🧪 Тест модуля уведомлений о клиентах
 */

const clientNotifications = require('./client-notifications');

// Тестовые данные
const testData = {
    years: {
        '2026': {
            expense: [
                // Клиент А покупал 7 дней назад
                {
                    date: getDateDaysAgo(7),
                    client: 'Клиент А',
                    product: 'Цемент',
                    warehouse: 'Склад 1',
                    quantity: 100,
                    total: 5000,
                    isDeleted: false
                },
                // Клиент Б покупал 7 дней назад
                {
                    date: getDateDaysAgo(7),
                    client: 'Клиент Б',
                    product: 'Песок',
                    warehouse: 'Склад 2',
                    quantity: 200,
                    total: 3000,
                    isDeleted: false
                },
                // Клиент В покупал 5 дней назад (не должен попасть в уведомления за 7 дней)
                {
                    date: getDateDaysAgo(5),
                    client: 'Клиент В',
                    product: 'Щебень',
                    warehouse: 'Склад 1',
                    quantity: 150,
                    total: 4000,
                    isDeleted: false
                },
                // Клиент А покупал еще раз 3 дня назад
                {
                    date: getDateDaysAgo(3),
                    client: 'Клиент А',
                    product: 'Цемент',
                    warehouse: 'Склад 1',
                    quantity: 50,
                    total: 2500,
                    isDeleted: false
                }
            ],
            payments: [
                // Клиент А частично оплатил
                {
                    date: getDateDaysAgo(5),
                    client: 'Клиент А',
                    amount: 3000,
                    isDeleted: false
                },
                // Клиент В полностью оплатил (не должен быть в должниках)
                {
                    date: getDateDaysAgo(2),
                    client: 'Клиент В',
                    amount: 4000,
                    isDeleted: false
                }
                // Клиент Б не оплачивал (полный должник)
            ]
        }
    }
};

// Функция для получения даты N дней назад
function getDateDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
}

// Запуск тестов
console.log('🧪 Запуск тестов уведомлений о клиентах\n');

console.log('📅 Тестовые даты:');
console.log(`   7 дней назад: ${getDateDaysAgo(7)}`);
console.log(`   5 дней назад: ${getDateDaysAgo(5)}`);
console.log(`   3 дня назад: ${getDateDaysAgo(3)}`);
console.log('');

// Тест 1: Поиск клиентов, которые покупали 7 дней назад
console.log('🔍 Тест 1: Клиенты, которые покупали 7 дней назад');
const clientsWithPurchases = clientNotifications.findClientsWithPurchaseOnDate(testData, '2026', 7);
console.log(`Найдено покупок: ${clientsWithPurchases.length}`);
clientsWithPurchases.forEach(purchase => {
    console.log(`   - ${purchase.client}: ${purchase.product}, ${purchase.total} $`);
});
console.log('');

// Тест 2: Поиск должников, которые покупали 7 дней назад
console.log('💳 Тест 2: Должники, которые покупали 7 дней назад');
const debtorsWithPurchases = clientNotifications.findDebtorsWithPurchaseOnDate(testData, '2026', 7);
console.log(`Найдено должников: ${debtorsWithPurchases.length}`);
debtorsWithPurchases.forEach(debtor => {
    console.log(`   - ${debtor.client}:`);
    console.log(`     Общий долг: ${clientNotifications.formatNumber(debtor.debt)} $`);
    console.log(`     Покупки 7 дней назад: ${clientNotifications.formatNumber(debtor.totalPurchaseAmount)} $`);
    console.log(`     Товары: ${debtor.purchases.map(p => p.product).join(', ')}`);
});
console.log('');

// Тест 3: Проверка расчета долгов
console.log('💰 Тест 3: Расчет долгов всех клиентов');
const allDebts = clientNotifications.calculateDebts(testData, '2026');
console.log('Все долги:');
Object.entries(allDebts || {}).forEach(([client, debt]) => {
    console.log(`   - ${client}: долг ${clientNotifications.formatNumber(debt.debt)} $ (купил на ${clientNotifications.formatNumber(debt.total)} $, оплатил ${clientNotifications.formatNumber(debt.paid)} $)`);
});
console.log('');

console.log('✅ Тесты завершены!');
console.log('');
console.log('📋 Ожидаемые результаты:');
console.log('   - Клиент А: должен быть в уведомлениях (долг 4500 $, покупал 7 дней назад)');
console.log('   - Клиент Б: должен быть в уведомлениях (долг 3000 $, покупал 7 дней назад)');
console.log('   - Клиент В: НЕ должен быть в уведомлениях (нет долга, полностью оплатил)');