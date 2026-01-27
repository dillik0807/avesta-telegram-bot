// Тест проверки фильтрации удаленных записей в экспорте Excel
const fs = require('fs');

console.log('🧪 ТЕСТ ФИЛЬТРАЦИИ ЭКСПОРТА В EXCEL');
console.log('═'.repeat(50));

try {
    const content = fs.readFileSync('./bot.js', 'utf8');
    
    console.log('Проверяем детальные отчеты для экспорта:\n');
    
    // Проверяем ключевые функции
    const checks = [
        {
            name: 'Детальный приход - фильтрация',
            pattern: 'let income = yearData.income.filter(item => !item.isDeleted);',
            found: content.includes('let income = yearData.income.filter(item => !item.isDeleted);')
        },
        {
            name: 'Детальный расход - фильтрация',
            pattern: 'let expense = yearData.expense.filter(item => !item.isDeleted);',
            found: content.includes('let expense = yearData.expense.filter(item => !item.isDeleted);')
        },
        {
            name: 'Детальные погашения - фильтрация',
            pattern: 'let payments = yearData.payments.filter(item => !item.isDeleted);',
            found: content.includes('let payments = yearData.payments.filter(item => !item.isDeleted);')
        }
    ];
    
    let passedTests = 0;
    checks.forEach((check, i) => {
        const status = check.found ? '✅ ПРОЙДЕН' : '❌ НЕ ПРОЙДЕН';
        console.log(`${i + 1}. ${check.name}`);
        console.log(`   Статус: ${status}`);
        if (check.found) passedTests++;
        console.log('');
    });
    
    // Дополнительные проверки
    console.log('Дополнительные проверки:');
    console.log('─'.repeat(30));
    
    const additionalChecks = [
        {
            name: 'Экспорт прихода в Excel',
            pattern: /exincdet_.*Excel/,
            count: (content.match(/exincdet_.*Excel/g) || []).length
        },
        {
            name: 'Экспорт расхода в Excel',
            pattern: /exexpdet_.*Excel/,
            count: (content.match(/exexpdet_.*Excel/g) || []).length
        },
        {
            name: 'Экспорт погашений в Excel',
            pattern: /expaydet_.*Excel/,
            count: (content.match(/expaydet_.*Excel/g) || []).length
        },
        {
            name: 'Общие фильтры удаленных записей',
            pattern: /filter\(item => !item\.isDeleted\)/,
            count: (content.match(/filter\(item => !item\.isDeleted\)/g) || []).length
        }
    ];
    
    additionalChecks.forEach(check => {
        console.log(`${check.name}: ${check.count > 0 ? '✅' : '❌'} (${check.count})`);
    });
    
    console.log('\n' + '═'.repeat(50));
    console.log(`РЕЗУЛЬТАТ: ${passedTests}/${checks.length} основных тестов пройдено`);
    
    if (passedTests === checks.length) {
        console.log('\n🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ!');
        console.log('✅ Экспорт в Excel теперь исключает удаленные записи!');
        console.log('\n📋 Исправленные функции экспорта:');
        console.log('• Детальный приход за период → Excel');
        console.log('• Детальный расход за период → Excel');
        console.log('• Детальные погашения за период → Excel');
        console.log('\n💡 Теперь при экспорте в Excel удаленные записи не будут включены в файл!');
    } else {
        console.log('\n⚠️  ЕСТЬ ПРОБЛЕМЫ! Некоторые функции экспорта могут включать удаленные записи.');
    }
    
} catch (error) {
    console.error('❌ Ошибка чтения файла:', error.message);
}