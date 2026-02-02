/**
 * 🧪 Тест функции итогов вагонов
 */

// Функция для получения даты N дней назад
function getDateDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
}

// Тестовые данные
const testData = {
    warehouses: [
        { name: 'Склад 1', group: 'Группа А' },
        { name: 'Склад 2', group: 'Группа Б' }
    ],
    years: {
        '2026': {
            income: [
                {
                    date: getDateDaysAgo(5),
                    wagon: 'Вагон-001',
                    company: 'ООО Поставщик',
                    warehouse: 'Склад 1',
                    product: 'Цемент',
                    qtyDoc: 1000,
                    qtyFact: 980,
                    isDeleted: false
                },
                {
                    date: getDateDaysAgo(3),
                    wagon: 'Вагон-002',
                    company: 'ООО Поставщик',
                    warehouse: 'Склад 1',
                    product: 'Цемент',
                    qtyDoc: 1200,
                    qtyFact: 1200,
                    isDeleted: false
                },
                {
                    date: getDateDaysAgo(2),
                    wagon: 'Вагон-003',
                    company: 'ИП Иванов',
                    warehouse: 'Склад 2',
                    product: 'Песок',
                    qtyDoc: 800,
                    qtyFact: 850,
                    isDeleted: false
                },
                // Удаленная запись - не должна учитываться
                {
                    date: getDateDaysAgo(1),
                    wagon: 'Вагон-004',
                    company: 'ООО Тест',
                    warehouse: 'Склад 1',
                    product: 'Щебень',
                    qtyDoc: 500,
                    qtyFact: 500,
                    isDeleted: true
                }
            ]
        }
    }
};

// Копируем функции из bot.js
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

const formatNumber = (num) => {
    return (num || 0).toFixed(2);
};

console.log('🧪 Тест функции итогов вагонов\n');

try {
    console.log('📊 Тестовые данные:');
    console.log(`   Записей прихода: ${testData.years['2026'].income.length}`);
    console.log(`   Активных записей: ${testData.years['2026'].income.filter(i => !i.isDeleted).length}`);
    console.log('');

    const wagonTotals = calculateWagonTotals(testData, '2026');
    
    if (!wagonTotals) {
        console.log('❌ Функция вернула null');
        process.exit(1);
    }
    
    console.log('✅ Функция calculateWagonTotals работает');
    console.log(`📦 Найдено позиций: ${wagonTotals.items.length}`);
    console.log('');
    
    console.log('📋 Детали по позициям:');
    wagonTotals.items.forEach((item, i) => {
        console.log(`${i + 1}. ${item.product} (${item.company}) - ${item.warehouse}`);
        console.log(`   🚂 Вагонов: ${item.wagons}`);
        console.log(`   📄 По док: ${item.qtyDoc} шт`);
        console.log(`   ✅ Факт: ${item.qtyFact} шт`);
        console.log(`   ⚖️ Вес: ${formatNumber(item.weightTons)} т`);
        console.log('');
    });
    
    console.log('📊 Общие итоги:');
    console.log(`   🚂 Всего вагонов: ${wagonTotals.totals.wagons}`);
    console.log(`   📄 По документам: ${wagonTotals.totals.qtyDoc} шт`);
    console.log(`   ✅ Фактически: ${wagonTotals.totals.qtyFact} шт`);
    console.log(`   📈 Разница: ${wagonTotals.totals.difference} шт`);
    console.log(`   ⚖️ Общий вес: ${formatNumber(wagonTotals.totals.weightTons)} т`);
    console.log('');
    
    // Проверка корректности расчетов
    let expectedWagons = 3; // 3 активных записи
    let expectedDoc = 1000 + 1200 + 800; // 3000
    let expectedFact = 980 + 1200 + 850; // 3030
    let expectedWeight = (980 + 1200 + 850) / 20; // 151.5
    
    console.log('🔍 Проверка расчетов:');
    console.log(`   Вагоны: ${wagonTotals.totals.wagons} === ${expectedWagons} ? ${wagonTotals.totals.wagons === expectedWagons ? '✅' : '❌'}`);
    console.log(`   По док: ${wagonTotals.totals.qtyDoc} === ${expectedDoc} ? ${wagonTotals.totals.qtyDoc === expectedDoc ? '✅' : '❌'}`);
    console.log(`   Факт: ${wagonTotals.totals.qtyFact} === ${expectedFact} ? ${wagonTotals.totals.qtyFact === expectedFact ? '✅' : '❌'}`);
    console.log(`   Вес: ${formatNumber(wagonTotals.totals.weightTons)} === ${formatNumber(expectedWeight)} ? ${formatNumber(wagonTotals.totals.weightTons) === formatNumber(expectedWeight) ? '✅' : '❌'}`);
    
    console.log('\n🎉 Тест завершен успешно!');
    
} catch (error) {
    console.error('❌ Ошибка в тесте:', error);
    console.error('Stack trace:', error.stack);
}