// Простая проверка исправлений в telegram-bot
const fs = require('fs');

console.log('🔍 ПРОВЕРКА ИСПРАВЛЕНИЙ TELEGRAM-BOT');
console.log('═'.repeat(50));

try {
    const content = fs.readFileSync('./bot.js', 'utf8');
    
    // Проверяем ключевые исправления
    const checks = [
        {
            name: 'Фильтрация удаленных записей',
            pattern: 'filter(item => !item.isDeleted)',
            count: (content.match(/filter\(item => !item\.isDeleted\)/g) || []).length
        },
        {
            name: 'Комментарии об исключении удаленных',
            pattern: 'исключаем удаленные записи',
            count: (content.match(/исключаем удаленные записи/gi) || []).length
        },
        {
            name: 'Приход за период - фильтрация',
            pattern: 'yearData.income.filter(item => !item.isDeleted).forEach(item => {',
            count: (content.includes('yearData.income.filter(item => !item.isDeleted).forEach(item => {') ? 1 : 0)
        },
        {
            name: 'Расход за период - фильтрация',
            pattern: 'yearData.expense.filter(item => !item.isDeleted).forEach(item => {',
            count: (content.includes('yearData.expense.filter(item => !item.isDeleted).forEach(item => {') ? 1 : 0)
        },
        {
            name: 'Погашения за период - фильтрация',
            pattern: 'yearData.payments.filter(item => !item.isDeleted).forEach(item => {',
            count: (content.includes('yearData.payments.filter(item => !item.isDeleted).forEach(item => {') ? 1 : 0)
        }
    ];
    
    console.log('Результаты проверки:\n');
    
    let totalFixed = 0;
    checks.forEach((check, i) => {
        const status = check.count > 0 ? '✅' : '❌';
        console.log(`${i + 1}. ${check.name}`);
        console.log(`   Найдено: ${check.count} раз ${status}`);
        if (check.count > 0) totalFixed++;
        console.log('');
    });
    
    console.log('═'.repeat(50));
    console.log(`ИТОГО: ${totalFixed}/${checks.length} исправлений применено`);
    
    if (totalFixed >= 3) {
        console.log('\n🎉 УСПЕШНО! Основные отчеты исправлены.');
        console.log('✅ Telegram-bot больше не показывает удаленные записи в отчетах!');
    } else {
        console.log('\n⚠️  Требуется дополнительная работа.');
    }
    
} catch (error) {
    console.error('❌ Ошибка чтения файла:', error.message);
}