// Исправление экспорта в Excel - добавление фильтрации удаленных записей
const fs = require('fs');

console.log('🔧 ИСПРАВЛЕНИЕ ЭКСПОРТА В EXCEL');
console.log('═'.repeat(50));

try {
    let content = fs.readFileSync('./bot.js', 'utf8');
    let changesCount = 0;
    
    // 1. Исправляем детальный отчет прихода
    const incomeDetailPattern = /\/\/ Фильтруем данные\s+let income = yearData\.income;\s+if \(dateFrom && dateTo\) \{\s+income = income\.filter\(item => \{\s+const itemDate = new Date\(item\.date\);\s+return itemDate >= dateFrom && itemDate <= dateTo;\s+\}\);\s+\}/;
    const incomeDetailReplacement = `// Фильтруем данные (исключаем удаленные записи)
        let income = yearData.income.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            income = income.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }`;
    
    if (incomeDetailPattern.test(content)) {
        content = content.replace(incomeDetailPattern, incomeDetailReplacement);
        console.log('✅ Исправлен детальный отчет прихода');
        changesCount++;
    }
    
    // 2. Исправляем детальный отчет расхода
    const expenseDetailPattern = /\/\/ Фильтруем данные\s+let expense = yearData\.expense;\s+if \(dateFrom && dateTo\) \{\s+expense = expense\.filter\(item => \{\s+const itemDate = new Date\(item\.date\);\s+return itemDate >= dateFrom && itemDate <= dateTo;\s+\}\);\s+\}/;
    const expenseDetailReplacement = `// Фильтруем данные (исключаем удаленные записи)
        let expense = yearData.expense.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            expense = expense.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }`;
    
    if (expenseDetailPattern.test(content)) {
        content = content.replace(expenseDetailPattern, expenseDetailReplacement);
        console.log('✅ Исправлен детальный отчет расхода');
        changesCount++;
    }
    
    // 3. Исправляем детальный отчет погашений
    const paymentsDetailPattern = /\/\/ Фильтруем данные\s+let payments = yearData\.payments;\s+if \(dateFrom && dateTo\) \{\s+payments = payments\.filter\(item => \{\s+const itemDate = new Date\(item\.date\);\s+return itemDate >= dateFrom && itemDate <= dateTo;\s+\}\);\s+\}/;
    const paymentsDetailReplacement = `// Фильтруем данные (исключаем удаленные записи)
        let payments = yearData.payments.filter(item => !item.isDeleted);
        if (dateFrom && dateTo) {
            payments = payments.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= dateFrom && itemDate <= dateTo;
            });
        }`;
    
    if (paymentsDetailPattern.test(content)) {
        content = content.replace(paymentsDetailPattern, paymentsDetailReplacement);
        console.log('✅ Исправлен детальный отчет погашений');
        changesCount++;
    }
    
    // Альтернативный подход - поиск и замена по строкам
    if (changesCount === 0) {
        console.log('⚠️  Паттерны не найдены, используем альтернативный подход...');
        
        // Ищем и заменяем конкретные строки
        const lines = content.split('\n');
        let modified = false;
        
        for (let i = 0; i < lines.length; i++) {
            // Ищем строки с "let income = yearData.income;"
            if (lines[i].includes('let income = yearData.income;')) {
                lines[i] = lines[i].replace('let income = yearData.income;', 'let income = yearData.income.filter(item => !item.isDeleted);');
                console.log(`✅ Исправлена строка ${i + 1}: детальный приход`);
                modified = true;
                changesCount++;
            }
            
            // Ищем строки с "let expense = yearData.expense;"
            if (lines[i].includes('let expense = yearData.expense;')) {
                lines[i] = lines[i].replace('let expense = yearData.expense;', 'let expense = yearData.expense.filter(item => !item.isDeleted);');
                console.log(`✅ Исправлена строка ${i + 1}: детальный расход`);
                modified = true;
                changesCount++;
            }
            
            // Ищем строки с "let payments = yearData.payments;"
            if (lines[i].includes('let payments = yearData.payments;')) {
                lines[i] = lines[i].replace('let payments = yearData.payments;', 'let payments = yearData.payments.filter(item => !item.isDeleted);');
                console.log(`✅ Исправлена строка ${i + 1}: детальные погашения`);
                modified = true;
                changesCount++;
            }
        }
        
        if (modified) {
            content = lines.join('\n');
        }
    }
    
    // Сохраняем изменения
    if (changesCount > 0) {
        fs.writeFileSync('./bot.js', content, 'utf8');
        console.log(`\n🎉 Применено ${changesCount} исправлений!`);
        console.log('✅ Файл bot.js обновлен');
        
        // Проверяем результат
        console.log('\n🔍 ПРОВЕРКА РЕЗУЛЬТАТА:');
        console.log('─'.repeat(30));
        
        const updatedContent = fs.readFileSync('./bot.js', 'utf8');
        const detailFilters = (updatedContent.match(/yearData\.(income|expense|payments)\.filter\(item => !item\.isDeleted\)/g) || []).length;
        
        console.log(`Найдено детальных фильтров: ${detailFilters}`);
        
        if (detailFilters >= 3) {
            console.log('\n🎉 УСПЕШНО! Экспорт в Excel теперь исключает удаленные записи!');
        } else {
            console.log('\n⚠️  Возможно, нужны дополнительные исправления');
        }
        
    } else {
        console.log('\n⚠️  Исправления не найдены или уже применены');
    }
    
} catch (error) {
    console.error('❌ Ошибка:', error.message);
}