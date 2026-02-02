/**
 * 🧪 Тест граничных случаев расчета долгов
 */

const clientNotifications = require('./client-notifications');

// Функция для получения даты N дней назад
function getDateDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
}

// Тестовые данные с граничными случаями
const testData = {
    years: {
        '2026': {
            expense: [
                // Клиент с очень маленьким долгом (0.01$)
                {
                    date: getDateDaysAgo(7),
                    client: 'Клиент Копейка',
                    product: 'Тест',
                    warehouse: 'Склад 1',
                    quantity: 1,
                    total: 100.01,
                    isDeleted: false
                },
                // Клиент с переплатой
                {
                    date: getDateDaysAgo(7),
                    client: 'Клиент Переплата',
                    product: 'Тест',
                    warehouse: 'Склад 1',
                    quantity: 1,
                    total: 1000,
                    isDeleted: false
                },
                // Клиент с точным погашением
                {
                    date: getDateDaysAgo(7),
                    client: 'Клиент Точно',
                    product: 'Тест',
                    warehouse: 'Склад 1',
                    quantity: 1,
                    total: 500,
                    isDeleted: false
                }
            ],
            payments: [
                // Клиент Копейка оплатил почти все (остался долг 0.01$)
                {
                    date: getDateDaysAgo(3),
                    client: 'Клиент Копейка',
                    amount: 100.00,
                    isDeleted: false
                },
                // Клиент Переплата переплатил
                {
                    date: getDateDaysAgo(3),
                    client: 'Клиент Переплата',
                    amount: 1200,
                    isDeleted: false
                },
                // Клиент Точно оплатил точно
                {
                    date: getDateDaysAgo(3),
                    client: 'Клиент Точно',
                    amount: 500,
                    isDeleted: false
                }
            ]
        }
    }
};

console.log('🧪 Тест граничных случаев расчета долгов\n');

// Тест расчета долгов
console.log('💰 Расчет долгов всех клиентов:');
const allDebts = clientNotifications.calculateDebts(testData, '2026');
Object.entries(allDebts || {}).forEach(([client, debt]) => {
    console.log(`   - ${client}: долг ${clientNotifications.formatNumber(debt.debt)} $ (купил ${clientNotifications.formatNumber(debt.total)} $, оплатил ${clientNotifications.formatNumber(debt.paid)} $)`);
});
console.log('');

// Тест поиска должников
console.log('🔍 Поиск должников, которые покупали 7 дней назад:');
const debtorsWithPurchases = clientNotifications.findDebtorsWithPurchaseOnDate(testData, '2026', 7);
console.log(`Найдено должников: ${debtorsWithPurchases.length}`);
debtorsWithPurchases.forEach(debtor => {
    console.log(`   - ${debtor.client}: долг ${clientNotifications.formatNumber(debtor.debt)} $`);
});
console.log('');

console.log('📋 Ожидаемые результаты:');
console.log('   - Клиент Копейка: должен быть в уведомлениях (долг 0.01 $)');
console.log('   - Клиент Переплата: НЕ должен быть в уведомлениях (переплата -200 $)');
console.log('   - Клиент Точно: НЕ должен быть в уведомлениях (долг 0.00 $)');
console.log('');

// Проверка результатов
let testsPassed = 0;
let totalTests = 3;

// Проверка 1: Клиент Копейка должен быть в списке
const hasKopeyka = debtorsWithPurchases.some(d => d.client === 'Клиент Копейка');
if (hasKopeyka) {
    console.log('✅ Тест 1 ПРОЙДЕН: Клиент с маленьким долгом (0.01$) найден');
    testsPassed++;
} else {
    console.log('❌ Тест 1 ПРОВАЛЕН: Клиент с маленьким долгом не найден');
}

// Проверка 2: Клиент Переплата НЕ должен быть в списке
const hasOverpay = debtorsWithPurchases.some(d => d.client === 'Клиент Переплата');
if (!hasOverpay) {
    console.log('✅ Тест 2 ПРОЙДЕН: Клиент с переплатой исключен');
    testsPassed++;
} else {
    console.log('❌ Тест 2 ПРОВАЛЕН: Клиент с переплатой найден в должниках');
}

// Проверка 3: Клиент Точно НЕ должен быть в списке
const hasExact = debtorsWithPurchases.some(d => d.client === 'Клиент Точно');
if (!hasExact) {
    console.log('✅ Тест 3 ПРОЙДЕН: Клиент с точным погашением исключен');
    testsPassed++;
} else {
    console.log('❌ Тест 3 ПРОВАЛЕН: Клиент с точным погашением найден в должниках');
}

console.log('');
console.log(`📊 Результат: ${testsPassed}/${totalTests} тестов пройдено`);

if (testsPassed === totalTests) {
    console.log('🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ! Логика работает корректно.');
} else {
    console.log('⚠️ Некоторые тесты провалены. Требуется доработка.');
}