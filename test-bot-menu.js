/**
 * 🧪 Тест меню бота - проверка наличия кнопки уведомлений
 */

const fs = require('fs');

console.log('🧪 Проверка меню телеграм бота\n');

// Читаем файл бота
const botContent = fs.readFileSync('./bot.js', 'utf8');

// Проверяем наличие кнопки в клавиатуре
const hasNotificationButton = botContent.includes('🔔 Уведомления о долгах');
console.log(`✅ Кнопка "🔔 Уведомления о долгах" в меню: ${hasNotificationButton ? 'ЕСТЬ' : 'НЕТ'}`);

// Проверяем наличие обработчика
const hasNotificationHandler = botContent.includes('bot.hears(/🔔|уведомления о долгах/i');
console.log(`✅ Обработчик уведомлений: ${hasNotificationHandler ? 'ЕСТЬ' : 'НЕТ'}`);

// Проверяем наличие обработчика выбора периода
const hasNotifyAction = botContent.includes('bot.action(/^notify_(\\d+)$/');
console.log(`✅ Обработчик выбора периода: ${hasNotifyAction ? 'ЕСТЬ' : 'НЕТ'}`);

// Проверяем наличие обработчика экспорта
const hasExportAction = botContent.includes('bot.action(/^exnotify_(\\d+)$/');
console.log(`✅ Обработчик экспорта: ${hasExportAction ? 'ЕСТЬ' : 'НЕТ'}`);

// Проверяем импорт модуля уведомлений
const hasModuleImport = botContent.includes("require('./client-notifications')");
console.log(`✅ Импорт модуля уведомлений: ${hasModuleImport ? 'ЕСТЬ' : 'НЕТ'}`);

console.log('\n📋 Результат проверки:');

if (hasNotificationButton && hasNotificationHandler && hasNotifyAction && hasExportAction && hasModuleImport) {
    console.log('🎉 ВСЕ КОМПОНЕНТЫ УВЕДОМЛЕНИЙ ДОБАВЛЕНЫ ПРАВИЛЬНО!');
    console.log('\n📱 Для тестирования:');
    console.log('1. Запустите бота: node bot.js');
    console.log('2. В Telegram перейдите в "📋 Отчёты"');
    console.log('3. Нажмите "🔔 Уведомления о долгах"');
    console.log('4. Выберите период (7/14/30 дней)');
} else {
    console.log('❌ НЕКОТОРЫЕ КОМПОНЕНТЫ ОТСУТСТВУЮТ!');
    console.log('Проверьте файл bot.js');
}

console.log('\n🔍 Дополнительная информация:');
console.log(`📄 Размер файла bot.js: ${Math.round(botContent.length / 1024)} KB`);
console.log(`📝 Строк кода: ${botContent.split('\n').length}`);

// Проверяем наличие файла модуля
const moduleExists = fs.existsSync('./client-notifications.js');
console.log(`📦 Файл client-notifications.js: ${moduleExists ? 'СУЩЕСТВУЕТ' : 'НЕ НАЙДЕН'}`);

if (moduleExists) {
    const moduleContent = fs.readFileSync('./client-notifications.js', 'utf8');
    console.log(`📦 Размер модуля: ${Math.round(moduleContent.length / 1024)} KB`);
}