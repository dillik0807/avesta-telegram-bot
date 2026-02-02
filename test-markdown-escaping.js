/**
 * 🧪 Тест экранирования Markdown символов (улучшенная версия)
 */

// Функции из bot.js
const escapeMarkdown = (text) => {
    if (!text) return '';
    return text.toString()
        .replace(/\\/g, '\\\\')  // Сначала экранируем обратные слеши
        .replace(/\*/g, '\\*')   // Звездочки
        .replace(/_/g, '\\_')    // Подчеркивания
        .replace(/\[/g, '\\[')   // Квадратные скобки
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')   // Круглые скобки
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')    // Тильда
        .replace(/`/g, '\\`')    // Обратные кавычки
        .replace(/>/g, '\\>')    // Больше
        .replace(/#/g, '\\#')    // Решетка
        .replace(/\+/g, '\\+')   // Плюс
        .replace(/-/g, '\\-')    // Минус
        .replace(/=/g, '\\=')    // Равно
        .replace(/\|/g, '\\|')   // Вертикальная черта
        .replace(/\{/g, '\\{')   // Фигурные скобки
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')   // Точка
        .replace(/!/g, '\\!');   // Восклицательный знак
};

console.log('🧪 Тест экранирования Markdown символов (улучшенная версия)\n');

// Тест с проблемными названиями компаний и складов
const problematicNames = [
    'ООО "Строй-Материалы"',
    'Склад №1 (основной)',
    'ИП Петров И.И.',
    'ТОО {Камень & Песок}',
    'Склад [Резерв]',
    'Цемент М-400',
    'Песок 0.5-1.2мм',
    'Щебень 5-20мм',
    'Материал #1',
    'Код: ABC_123',
    'Примечание: важно!',
    'Размер: ~50см'
];

console.log('📋 Тестирование экранирования проблемных названий:');
problematicNames.forEach((name, i) => {
    const escaped = escapeMarkdown(name);
    console.log(`${i + 1}. "${name}" → "${escaped}"`);
});
console.log('');

// Тест формирования реального сообщения
console.log('📤 Тест формирования реального сообщения:');

const testData = [
    {
        warehouse: 'Склад №1 (основной)',
        items: [
            { product: 'Цемент М-400', company: 'ООО "СтройМат"', wagons: 3, qtyDoc: 1500, qtyFact: 1480 },
            { product: 'Песок 0.5-1.2мм', company: 'ИП Петров И.И.', wagons: 2, qtyDoc: 800, qtyFact: 820 }
        ]
    },
    {
        warehouse: 'Склад [Резерв]',
        items: [
            { product: 'Щебень 5-20мм', company: 'ТОО {Камень}', wagons: 1, qtyDoc: 600, qtyFact: 590 }
        ]
    }
];

let msg = `🚂 *ИТОГИ ВАГОНОВ*\n📅 2026\n${'═'.repeat(25)}\n\n`;

testData.forEach(warehouseData => {
    msg += `🏪 *${escapeMarkdown(warehouseData.warehouse)}*\n`;
    msg += `${'─'.repeat(20)}\n`;
    
    let whWagons = 0, whDoc = 0, whFact = 0, whTons = 0;
    
    warehouseData.items.forEach(item => {
        msg += `📦 ${escapeMarkdown(item.product)} (${escapeMarkdown(item.company)})\n`;
        msg += `   🚂 Вагонов: ${item.wagons}\n`;
        msg += `   📄 По док: ${item.qtyDoc} шт\n`;
        msg += `   ✅ Факт: ${item.qtyFact} шт\n`;
        const diff = item.qtyFact - item.qtyDoc;
        const diffIcon = diff >= 0 ? '📈' : '📉';
        msg += `   ${diffIcon} Разница: ${diff} шт\n`;
        msg += `   ⚖️ Вес: ${(item.qtyFact / 20).toFixed(2)} т\n\n`;
        
        whWagons += item.wagons;
        whDoc += item.qtyDoc;
        whFact += item.qtyFact;
        whTons += item.qtyFact / 20;
    });
    
    msg += `📊 *Итого ${escapeMarkdown(warehouseData.warehouse)}:*\n`;
    msg += `   🚂 ${whWagons} вагонов, ⚖️ ${whTons.toFixed(2)} т\n\n`;
});

const totalWagons = testData.reduce((sum, wh) => sum + wh.items.reduce((s, i) => s + i.wagons, 0), 0);
const totalDoc = testData.reduce((sum, wh) => sum + wh.items.reduce((s, i) => s + i.qtyDoc, 0), 0);
const totalFact = testData.reduce((sum, wh) => sum + wh.items.reduce((s, i) => s + i.qtyFact, 0), 0);
const totalTons = totalFact / 20;

msg += `${'═'.repeat(25)}\n`;
msg += `🚂 *ОБЩИЙ ИТОГ:*\n`;
msg += `   Вагонов: *${totalWagons}*\n`;
msg += `   По документам: *${totalDoc}* шт\n`;
msg += `   Фактически: *${totalFact}* шт\n`;
msg += `   Разница: *${totalFact - totalDoc}* шт\n`;
msg += `   Вес: *${totalTons.toFixed(2)} тонн*`;

console.log('✅ Сообщение сформировано');
console.log(`📏 Длина: ${msg.length} символов`);
console.log('');

// Проверяем на неэкранированные символы в пользовательском контенте
console.log('🔍 Проверка экранирования:');
const lines = msg.split('\n');
let hasProblems = false;

lines.forEach((line, i) => {
    // Ищем строки с пользовательским контентом (названия складов, товаров, компаний)
    if (line.includes('📦') || (line.includes('🏪') && line.includes('*'))) {
        // Проверяем что все специальные символы экранированы
        const problematicChars = ['(', ')', '[', ']', '{', '}', '.', '-', '#', '!'];
        problematicChars.forEach(char => {
            if (line.includes(char) && !line.includes('\\' + char)) {
                // Исключаем символы, которые используются для форматирования
                if (!(char === '(' && line.includes('(')) && 
                    !(char === ')' && line.includes(')'))) {
                    console.log(`⚠️ Строка ${i + 1}: неэкранированный "${char}" в "${line.trim()}"`);
                    hasProblems = true;
                }
            }
        });
    }
});

if (!hasProblems) {
    console.log('✅ Все пользовательские данные правильно экранированы');
} else {
    console.log('❌ Найдены проблемы с экранированием');
}

console.log('\n📋 Первые 800 символов сообщения:');
console.log(msg.substring(0, 800));
console.log('...');

console.log('\n🎉 Тест завершен!');