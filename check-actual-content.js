// Проверяем реальное содержимое файла
const fs = require('fs');

const content = fs.readFileSync('./bot.js', 'utf8');

// Ищем строки вокруг отчетов
const lines = content.split('\n');

console.log('🔍 ПРОВЕРКА РЕАЛЬНОГО СОДЕРЖИМОГО ФАЙЛА');
console.log('═'.repeat(50));

// Ищем функции отчетов
const searchPatterns = [
    { name: 'Приход за период', pattern: /приход за период/i },
    { name: 'Расход за период', pattern: /расход за период/i },
    { name: 'Погашения за период', pattern: /погашения за период/i }
];

searchPatterns.forEach(search => {
    console.log(`\n📋 ${search.name}:`);
    console.log('─'.repeat(30));
    
    lines.forEach((line, index) => {
        if (search.pattern.test(line)) {
            console.log(`Найдено на строке ${index + 1}: ${line.trim()}`);
            
            // Показываем следующие 15 строк
            for (let i = 1; i <= 15; i++) {
                if (lines[index + i]) {
                    const nextLine = lines[index + i].trim();
                    if (nextLine.includes('yearData.') && nextLine.includes('forEach')) {
                        console.log(`  Строка ${index + i + 1}: ${nextLine}`);
                        if (nextLine.includes('filter') && nextLine.includes('isDeleted')) {
                            console.log('    ✅ ФИЛЬТРАЦИЯ НАЙДЕНА!');
                        } else {
                            console.log('    ❌ БЕЗ ФИЛЬТРАЦИИ');
                        }
                        break;
                    }
                }
            }
        }
    });
});

// Проверяем calculateWagonTotals
console.log('\n📋 calculateWagonTotals:');
console.log('─'.repeat(30));
const wagonTotalsIndex = lines.findIndex(line => line.includes('calculateWagonTotals'));
if (wagonTotalsIndex !== -1) {
    for (let i = 0; i < 20; i++) {
        if (lines[wagonTotalsIndex + i]) {
            const line = lines[wagonTotalsIndex + i].trim();
            if (line.includes('yearData.income') && line.includes('forEach')) {
                console.log(`Строка ${wagonTotalsIndex + i + 1}: ${line}`);
                if (line.includes('filter') && line.includes('isDeleted')) {
                    console.log('  ✅ ФИЛЬТРАЦИЯ НАЙДЕНА!');
                } else {
                    console.log('  ❌ БЕЗ ФИЛЬТРАЦИИ');
                }
                break;
            }
        }
    }
}

console.log('\n═'.repeat(50));
console.log('Проверка завершена.');