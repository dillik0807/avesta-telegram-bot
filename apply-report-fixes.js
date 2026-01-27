// Скрипт для применения исправлений фильтрации удаленных записей в отчетах
const fs = require('fs');

console.log('🔧 ПРИМЕНЕНИЕ ИСПРАВЛЕНИЙ ФИЛЬТРАЦИИ ОТЧЕТОВ');
console.log('═'.repeat(50));

try {
    let content = fs.readFileSync('./bot.js', 'utf8');
    let changesCount = 0;
    
    // 1. Исправляем приход за период
    const incomeOld = 'yearData.income.forEach(item => {';
    const incomeNew = 'yearData.income.filter(item => !item.isDeleted).forEach(item => {';
    if (content.includes(incomeOld)) {
        content = content.replace(incomeOld, incomeNew);
        console.log('✅ Исправлен отчет прихода за период');
        changesCount++;
    }
    
    // 2. Исправляем расход за период
    const expenseOld = 'yearData.expense.forEach(item => {';
    const expenseNew = 'yearData.expense.filter(item => !item.isDeleted).forEach(item => {';
    if (content.includes(expenseOld)) {
        content = content.replace(expenseOld, expenseNew);
        console.log('✅ Исправлен отчет расхода за период');
        changesCount++;
    }
    
    // 3. Исправляем погашения за период
    const paymentsOld = 'yearData.payments.forEach(item => {';
    const paymentsNew = 'yearData.payments.filter(item => !item.isDeleted).forEach(item => {';
    if (content.includes(paymentsOld)) {
        content = content.replace(paymentsOld, paymentsNew);
        console.log('✅ Исправлен отчет погашений за период');
        changesCount++;
    }
    
    // 4. Исправляем calculateWagonTotals
    const wagonTotalsPattern = /const calculateWagonTotals = \(data, year\) => \{[\s\S]*?yearData\.income\.forEach\(item => \{/;
    const wagonTotalsMatch = content.match(wagonTotalsPattern);
    if (wagonTotalsMatch) {
        const wagonTotalsFixed = wagonTotalsMatch[0].replace(
            'yearData.income.forEach(item => {',
            'yearData.income.filter(item => !item.isDeleted).forEach(item => {'
        );
        content = content.replace(wagonTotalsMatch[0], wagonTotalsFixed);
        console.log('✅ Исправлена функция calculateWagonTotals');
        changesCount++;
    }
    
    // 5. Исправляем сбор клиентов из расходов
    const clientCollectionPattern = /yearData\.expense\.forEach\(e => \{[\s\S]*?if \(e\.client && !clientNames\.includes\(e\.client\)\)/;
    const clientCollectionMatch = content.match(clientCollectionPattern);
    if (clientCollectionMatch) {
        const clientCollectionFixed = clientCollectionMatch[0].replace(
            'yearData.expense.forEach(e => {',
            'yearData.expense.filter(e => !e.isDeleted).forEach(e => {'
        );
        content = content.replace(clientCollectionMatch[0], clientCollectionFixed);
        console.log('✅ Исправлен сбор клиентов из расходов');
        changesCount++;
    }
    
    // Сохраняем изменения
    if (changesCount > 0) {
        fs.writeFileSync('./bot.js', content, 'utf8');
        console.log(`\n🎉 Применено ${changesCount} исправлений!`);
        console.log('✅ Файл bot.js обновлен');
    } else {
        console.log('\n⚠️  Исправления уже применены или не найдены паттерны для замены');
    }
    
    // Проверяем результат
    console.log('\n🔍 ПРОВЕРКА РЕЗУЛЬТАТА:');
    console.log('─'.repeat(30));
    
    const updatedContent = fs.readFileSync('./bot.js', 'utf8');
    const filterCount = (updatedContent.match(/filter\(item => !item\.isDeleted\)/g) || []).length;
    const filterECount = (updatedContent.match(/filter\(e => !e\.isDeleted\)/g) || []).length;
    
    console.log(`Найдено фильтров "filter(item => !item.isDeleted)": ${filterCount}`);
    console.log(`Найдено фильтров "filter(e => !e.isDeleted)": ${filterECount}`);
    
    if (filterCount >= 9) {
        console.log('\n🎉 УСПЕШНО! Все отчеты теперь исключают удаленные записи!');
    } else {
        console.log('\n⚠️  Возможно, нужны дополнительные исправления');
    }
    
} catch (error) {
    console.error('❌ Ошибка:', error.message);
}