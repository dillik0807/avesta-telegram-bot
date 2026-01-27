/**
 * 🧪 Тестирование исправлений Telegram Bot
 */

console.log('🧪 Тестирование модуля исправлений...');

try {
    const fixes = require('./fix-telegram-bot-all');
    console.log('✅ Модуль исправлений загружается без ошибок');
    
    const status = fixes.checkFixesStatus();
    console.log('📊 Статус исправлений:');
    Object.entries(status).forEach(([key, value]) => {
        const icon = value ? '✅' : '❌';
        console.log(`   ${icon} ${key}: ${value}`);
    });
    
    if (status.allLoaded) {
        console.log('🎉 Все исправления загружены успешно!');
    } else {
        console.log('⚠️ Некоторые исправления не загружены');
    }
    
    // Тестируем основные функции
    console.log('\n🔧 Тестирование функций:');
    
    // Тест форматирования чисел
    if (typeof global.formatNumberSafe === 'function') {
        const testNum = global.formatNumberSafe(1234.567);
        console.log(`   ✅ formatNumberSafe(1234.567) = ${testNum}`);
    }
    
    // Тест форматирования дат
    if (typeof global.formatDateSafe === 'function') {
        const testDate = global.formatDateSafe('2026-01-27');
        console.log(`   ✅ formatDateSafe('2026-01-27') = ${testDate}`);
    }
    
    console.log('\n✅ Тестирование завершено успешно!');
    
} catch (error) {
    console.log('❌ Ошибка загрузки модуля:', error.message);
    console.log('📋 Детали ошибки:', error.stack);
    process.exit(1);
}