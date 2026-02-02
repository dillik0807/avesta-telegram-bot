/**
 * 🧪 Тест подключения к Firebase
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');

const FIREBASE_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_FILE = './firebase-service-account.json';

console.log('🧪 Тест подключения к Firebase\n');

// Проверяем переменные окружения
console.log('🔧 Проверка конфигурации:');
console.log(`   FIREBASE_DATABASE_URL: ${FIREBASE_URL ? '✅ Установлен' : '❌ Не установлен'}`);
console.log(`   FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅ Установлен' : '❌ Не установлен'}`);
console.log(`   Файл service account: ${fs.existsSync(SERVICE_ACCOUNT_FILE) ? '✅ Существует' : '❌ Не найден'}`);
console.log('');

if (!FIREBASE_URL) {
    console.log('❌ FIREBASE_DATABASE_URL не установлен!');
    process.exit(1);
}

// Функция получения данных (копия из bot.js)
const getData = () => new Promise(async (resolve, reject) => {
    // Пробуем Firebase Admin SDK
    let firebaseAdmin = null;
    let firebaseDb = null;
    
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const admin = require('firebase-admin');
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: FIREBASE_URL
            });
            firebaseDb = admin.database();
            firebaseAdmin = admin;
            console.log('✅ Firebase Admin SDK инициализирован (из ENV)');
        } catch (e) {
            console.log('⚠️ Ошибка инициализации Firebase из ENV:', e.message);
        }
    }
    else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        try {
            const admin = require('firebase-admin');
            const serviceAccount = require(SERVICE_ACCOUNT_FILE);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: FIREBASE_URL
            });
            firebaseDb = admin.database();
            firebaseAdmin = admin;
            console.log('✅ Firebase Admin SDK инициализирован (из файла)');
        } catch (e) {
            console.log('⚠️ Не удалось инициализировать Firebase Admin:', e.message);
        }
    }

    // Если есть Admin SDK - используем его
    if (firebaseDb) {
        try {
            console.log('📡 Запрос данных через Firebase Admin SDK...');
            const snapshot = await firebaseDb.ref('/').once('value');
            const rawData = snapshot.val();
            console.log('📦 Данные получены через Admin SDK, ключи:', rawData ? Object.keys(rawData) : 'null');
            
            let data = rawData;
            if (rawData && rawData.retailAppData) {
                console.log('📂 Используем retailAppData');
                data = rawData.retailAppData;
            }
            if (rawData && rawData.data) {
                console.log('📂 Используем data');
                data = rawData.data;
            }
            
            resolve(data);
            return;
        } catch (e) {
            console.error('❌ Firebase Admin ошибка:', e.message);
        }
    }
    
    // Иначе пробуем REST API
    console.log('📡 Запрос данных через REST API...');
    https.get(`${FIREBASE_URL}/.json`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed && parsed.error) {
                    console.log('❌ Firebase REST ошибка:', parsed.error);
                    resolve(null);
                } else {
                    console.log('📦 Данные получены через REST API, ключи:', parsed ? Object.keys(parsed) : 'null');
                    
                    if (parsed && parsed.retailAppData) {
                        resolve(parsed.retailAppData);
                    } else if (parsed && parsed.data) {
                        resolve(parsed.data);
                    } else {
                        resolve(parsed);
                    }
                }
            } catch (e) { 
                console.error('❌ Ошибка парсинга JSON:', e.message);
                reject(e); 
            }
        });
    }).on('error', (e) => {
        console.error('❌ Ошибка HTTP запроса:', e.message);
        reject(e);
    });
});

// Запуск теста
(async () => {
    try {
        console.log('🔄 Попытка получения данных...');
        const data = await getData();
        
        if (!data) {
            console.log('❌ Данные не получены (null)');
            return;
        }
        
        console.log('✅ Данные успешно получены!');
        console.log('📊 Структура данных:');
        console.log(`   Ключи верхнего уровня: ${Object.keys(data).join(', ')}`);
        
        if (data.years) {
            const years = Object.keys(data.years);
            console.log(`   Доступные годы: ${years.join(', ')}`);
            
            // Проверяем данные за текущий год
            const currentYear = '2026';
            if (data.years[currentYear]) {
                const yearData = data.years[currentYear];
                console.log(`   Данные за ${currentYear}:`);
                console.log(`     income: ${yearData.income ? yearData.income.length : 0} записей`);
                console.log(`     expense: ${yearData.expense ? yearData.expense.length : 0} записей`);
                console.log(`     payments: ${yearData.payments ? yearData.payments.length : 0} записей`);
                
                if (yearData.income && yearData.income.length > 0) {
                    const activeIncome = yearData.income.filter(item => !item.isDeleted);
                    console.log(`     активных записей прихода: ${activeIncome.length}`);
                    
                    if (activeIncome.length > 0) {
                        console.log('✅ Есть данные для расчета итогов вагонов');
                    } else {
                        console.log('⚠️ Нет активных записей прихода');
                    }
                } else {
                    console.log('⚠️ Нет записей прихода');
                }
            } else {
                console.log(`⚠️ Нет данных за ${currentYear} год`);
            }
        } else {
            console.log('⚠️ Нет структуры years в данных');
        }
        
        console.log('\n🎉 Тест подключения завершен успешно!');
        
    } catch (error) {
        console.error('❌ Ошибка теста:', error.message);
        console.error('Stack trace:', error.stack);
    }
})();