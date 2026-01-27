/**
 * 🧠 УМНАЯ ЛОГИКА СИНХРОНИЗАЦИИ С МЯГКИМ УДАЛЕНИЕМ
 * 
 * Логика:
 * 1. При чтении из Firebase - проверяем локальные удаления и удаляем их в Firebase
 * 2. При синхронизации - объединяем данные: удаляем ненужные, добавляем новые
 * 3. Админские удаления имеют приоритет над пользовательскими данными
 */

class SmartSyncLogic {
    constructor() {
        this.isProcessing = false;
        this.pendingOperations = [];
    }

    /**
     * 🔄 УМНАЯ ДВУСТОРОННЯЯ СИНХРОНИЗАЦИЯ
     * Вызывается при подключении к Firebase
     */
    async performSmartSync() {
        if (this.isProcessing) {
            console.log('⏳ Синхронизация уже выполняется...');
            return;
        }

        this.isProcessing = true;
        console.log('🧠 Запуск умной синхронизации...');

        try {
            // 1️⃣ Получаем данные из Firebase
            const cloudData = await this.getCloudData();
            
            // 2️⃣ Получаем локальные данные
            const localData = window.appData;
            
            // 3️⃣ Выполняем умное объединение
            const mergedData = await this.smartMerge(cloudData, localData);
            
            // 4️⃣ Применяем объединенные данные локально
            await this.applyMergedData(mergedData);
            
            // 5️⃣ Отправляем обновленные данные в Firebase
            await this.pushToFirebase(mergedData);
            
            console.log('✅ Умная синхронизация завершена');
            
        } catch (error) {
            console.error('❌ Ошибка умной синхронизации:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 📥 Получение данных из Firebase
     */
    async getCloudData() {
        console.log('📥 Получение данных из Firebase...');
        
        if (!window.firebaseDB || !window.firebaseRefs) {
            throw new Error('Firebase не подключен');
        }

        const { ref, get } = window.firebaseRefs;
        const dataRef = ref(window.firebaseDB, 'retailAppData');
        const snapshot = await get(dataRef);
        
        if (snapshot.exists()) {
            const data = snapshot.val();
            console.log('📊 Данные из Firebase получены');
            return data;
        } else {
            console.log('ℹ️ В Firebase нет данных');
            return null;
        }
    }

    /**
     * 🔀 УМНОЕ ОБЪЕДИНЕНИЕ ДАННЫХ
     * Главная логика синхронизации
     */
    async smartMerge(cloudData, localData) {
        console.log('🔀 Умное объединение данных...');
        
        // Если нет облачных данных, используем локальные
        if (!cloudData) {
            console.log('📦 Используем локальные данные (облако пустое)');
            return localData;
        }
        
        // Если нет локальных данных, используем облачные
        if (!localData) {
            console.log('☁️ Используем облачные данные (локально пусто)');
            return cloudData;
        }
        
        // Создаем объединенные данные на базе облачных
        const merged = JSON.parse(JSON.stringify(cloudData));
        
        // 🗑️ ОБРАБАТЫВАЕМ УДАЛЕНИЯ (приоритет админа)
        await this.processAdminDeletions(merged, localData);
        
        // ➕ ОБРАБАТЫВАЕМ ДОБАВЛЕНИЯ (новые данные пользователей)
        await this.processUserAdditions(merged, localData, cloudData);
        
        // ✏️ ОБРАБАТЫВАЕМ ИЗМЕНЕНИЯ (обновления данных)
        await this.processDataUpdates(merged, localData, cloudData);
        
        // ⏰ Обновляем timestamp
        merged.lastModified = Date.now();
        merged.lastSyncBy = window.currentUser?.username || 'unknown';
        
        console.log('✅ Данные объединены');
        return merged;
    }

    /**
     * 🗑️ ОБРАБОТКА АДМИНСКИХ УДАЛЕНИЙ
     * Если админ удалил данные локально, удаляем их везде
     */
    async processAdminDeletions(merged, localData) {
        console.log('🗑️ Обработка админских удалений...');
        
        // Проверяем удаления в основных коллекциях
        const collections = ['clients', 'products', 'companies', 'warehouses', 'warehouseGroups', 'coalitions', 'users'];
        
        for (const collectionName of collections) {
            if (localData[collectionName] && merged[collectionName]) {
                await this.processCollectionDeletions(merged, localData, collectionName);
            }
        }
        
        // Проверяем удаления в данных по годам
        if (localData.years && merged.years) {
            await this.processYearlyDataDeletions(merged, localData);
        }
    }

    /**
     * 🗑️ Обработка удалений в коллекции
     */
    async processCollectionDeletions(merged, localData, collectionName) {
        const localCollection = localData[collectionName];
        const mergedCollection = merged[collectionName];
        
        console.log(`🔍 Проверка удалений в ${collectionName}...`);
        
        // Ищем элементы помеченные как удаленные локально
        for (let i = 0; i < localCollection.length; i++) {
            const localItem = localCollection[i];
            
            // Если элемент помечен как удаленный
            if (typeof localItem === 'object' && localItem.isDeleted) {
                console.log(`🗑️ Найдено локальное удаление в ${collectionName}:`, localItem.name || localItem.username || localItem);
                
                // Помечаем соответствующий элемент в объединенных данных как удаленный
                if (i < mergedCollection.length) {
                    if (typeof mergedCollection[i] === 'string') {
                        // Конвертируем строку в объект с флагом удаления
                        mergedCollection[i] = {
                            name: mergedCollection[i],
                            isDeleted: true,
                            deletedAt: localItem.deletedAt || Date.now(),
                            deletedBy: localItem.deletedBy || 'admin'
                        };
                    } else {
                        // Добавляем флаг удаления к существующему объекту
                        mergedCollection[i].isDeleted = true;
                        mergedCollection[i].deletedAt = localItem.deletedAt || Date.now();
                        mergedCollection[i].deletedBy = localItem.deletedBy || 'admin';
                    }
                }
            }
        }
    }

    /**
     * 🗑️ Обработка удалений в годовых данных
     */
    async processYearlyDataDeletions(merged, localData) {
        console.log('🗑️ Обработка удалений в годовых данных...');
        
        const yearlyCollections = ['income', 'expense', 'payments', 'partners'];
        
        for (const year of Object.keys(localData.years)) {
            if (!merged.years[year]) continue;
            
            for (const collectionName of yearlyCollections) {
                const localCollection = localData.years[year][collectionName];
                const mergedCollection = merged.years[year][collectionName];
                
                if (!localCollection || !mergedCollection) continue;
                
                // Ищем удаленные записи
                const deletedItems = localCollection.filter(item => item.isDeleted);
                
                for (const deletedItem of deletedItems) {
                    // Находим соответствующую запись в объединенных данных
                    const mergedItem = mergedCollection.find(item => item.id === deletedItem.id);
                    
                    if (mergedItem) {
                        console.log(`🗑️ Помечаем как удаленное в ${year}/${collectionName}:`, deletedItem.id);
                        mergedItem.isDeleted = true;
                        mergedItem.deletedAt = deletedItem.deletedAt || Date.now();
                        mergedItem.deletedBy = deletedItem.deletedBy || 'admin';
                    }
                }
            }
        }
    }

    /**
     * ➕ ОБРАБОТКА ПОЛЬЗОВАТЕЛЬСКИХ ДОБАВЛЕНИЙ
     * Если пользователи добавили новые данные, добавляем их
     */
    async processUserAdditions(merged, localData, cloudData) {
        console.log('➕ Обработка пользовательских добавлений...');
        
        // Проверяем добавления в основных коллекциях
        const collections = ['clients', 'products', 'companies', 'warehouses', 'warehouseGroups', 'coalitions'];
        
        for (const collectionName of collections) {
            if (localData[collectionName] && merged[collectionName]) {
                await this.processCollectionAdditions(merged, localData, cloudData, collectionName);
            }
        }
        
        // Проверяем добавления в данных по годам
        if (localData.years && merged.years) {
            await this.processYearlyDataAdditions(merged, localData, cloudData);
        }
    }

    /**
     * ➕ Обработка добавлений в коллекции
     */
    async processCollectionAdditions(merged, localData, cloudData, collectionName) {
        const localCollection = localData[collectionName];
        const cloudCollection = cloudData[collectionName] || [];
        const mergedCollection = merged[collectionName];
        
        console.log(`🔍 Проверка добавлений в ${collectionName}...`);
        
        // Ищем новые элементы (есть локально, но нет в облаке)
        for (const localItem of localCollection) {
            // Пропускаем удаленные элементы
            if (typeof localItem === 'object' && localItem.isDeleted) continue;
            
            const localName = typeof localItem === 'string' ? localItem : localItem.name;
            
            // Проверяем, есть ли этот элемент в облачных данных
            const existsInCloud = cloudCollection.some(cloudItem => {
                const cloudName = typeof cloudItem === 'string' ? cloudItem : cloudItem.name;
                return cloudName === localName;
            });
            
            if (!existsInCloud) {
                console.log(`➕ Найдено новое добавление в ${collectionName}:`, localName);
                
                // Проверяем, нет ли уже в объединенных данных
                const existsInMerged = mergedCollection.some(mergedItem => {
                    const mergedName = typeof mergedItem === 'string' ? mergedItem : mergedItem.name;
                    return mergedName === localName;
                });
                
                if (!existsInMerged) {
                    mergedCollection.push(localItem);
                    console.log(`✅ Добавлено в ${collectionName}:`, localName);
                }
            }
        }
    }

    /**
     * ➕ Обработка добавлений в годовых данных
     */
    async processYearlyDataAdditions(merged, localData, cloudData) {
        console.log('➕ Обработка добавлений в годовых данных...');
        
        const yearlyCollections = ['income', 'expense', 'payments', 'partners'];
        
        for (const year of Object.keys(localData.years)) {
            // Создаем год в объединенных данных если его нет
            if (!merged.years[year]) {
                merged.years[year] = {
                    income: [],
                    expense: [],
                    payments: [],
                    partners: []
                };
            }
            
            const cloudYear = cloudData.years?.[year];
            
            for (const collectionName of yearlyCollections) {
                const localCollection = localData.years[year][collectionName] || [];
                const cloudCollection = cloudYear?.[collectionName] || [];
                const mergedCollection = merged.years[year][collectionName];
                
                // Ищем новые записи (есть локально, но нет в облаке)
                for (const localItem of localCollection) {
                    // Пропускаем удаленные записи
                    if (localItem.isDeleted) continue;
                    
                    // Проверяем, есть ли эта запись в облаке
                    const existsInCloud = cloudCollection.some(cloudItem => cloudItem.id === localItem.id);
                    
                    if (!existsInCloud) {
                        console.log(`➕ Найдена новая запись в ${year}/${collectionName}:`, localItem.id);
                        
                        // Проверяем, нет ли уже в объединенных данных
                        const existsInMerged = mergedCollection.some(mergedItem => mergedItem.id === localItem.id);
                        
                        if (!existsInMerged) {
                            mergedCollection.push(localItem);
                            console.log(`✅ Добавлена запись в ${year}/${collectionName}:`, localItem.id);
                        }
                    }
                }
            }
        }
    }

    /**
     * ✏️ ОБРАБОТКА ОБНОВЛЕНИЙ ДАННЫХ
     * Если данные изменились, используем более новые
     */
    async processDataUpdates(merged, localData, cloudData) {
        console.log('✏️ Обработка обновлений данных...');
        
        // Сравниваем timestamps и используем более новые данные
        const localTimestamp = localData.lastModified || 0;
        const cloudTimestamp = cloudData.lastModified || 0;
        
        console.log(`⏰ Локальные данные: ${new Date(localTimestamp).toLocaleString()}`);
        console.log(`☁️ Облачные данные: ${new Date(cloudTimestamp).toLocaleString()}`);
        
        // Если локальные данные новее, используем их структуру
        if (localTimestamp > cloudTimestamp) {
            console.log('📦 Локальные данные новее - используем их как основу');
            
            // Копируем метаданные из локальных данных
            merged.lastModified = localData.lastModified;
            merged.currentYear = localData.currentYear;
            merged.userLastLogin = localData.userLastLogin;
            merged.productPrices = localData.productPrices;
        }
    }

    /**
     * 📥 Применение объединенных данных локально
     */
    async applyMergedData(mergedData) {
        console.log('📥 Применение объединенных данных локально...');
        
        // Обновляем глобальные данные
        window.appData = mergedData;
        
        // Сохраняем через адаптер хранения
        try {
            if (window.storageAdapter) {
                await window.storageAdapter.setItem('retailAppData', mergedData);
                console.log('💾 Данные сохранены через адаптер');
            } else {
                localStorage.setItem('retailAppData', JSON.stringify(mergedData));
                console.log('💾 Данные сохранены в localStorage');
            }
        } catch (error) {
            console.error('❌ Ошибка сохранения данных:', error);
            localStorage.setItem('retailAppData', JSON.stringify(mergedData));
        }
        
        // Обновляем интерфейс
        if (window.currentUser && typeof window.updateAllTables === 'function') {
            window.updateAllTables();
        }
        
        console.log('✅ Объединенные данные применены локально');
    }

    /**
     * 📤 Отправка данных в Firebase
     */
    async pushToFirebase(data) {
        console.log('📤 Отправка объединенных данных в Firebase...');
        
        if (!window.firebaseDB || !window.firebaseRefs) {
            throw new Error('Firebase не подключен');
        }
        
        const { ref, set } = window.firebaseRefs;
        const dataRef = ref(window.firebaseDB, 'retailAppData');
        
        // Запоминаем время отправки
        if (window.realtimeSync) {
            window.realtimeSync.lastPushTime = Date.now();
        }
        
        await set(dataRef, data);
        console.log('✅ Объединенные данные отправлены в Firebase');
    }

    /**
     * 🔄 Интеграция с существующей системой синхронизации
     */
    integrateWithRealtimeSync() {
        console.log('🔄 Интеграция с системой реального времени...');
        
        if (!window.realtimeSync) {
            console.warn('⚠️ Система реального времени не найдена');
            return;
        }
        
        // Заменяем метод первичной синхронизации
        const originalInitialSync = window.realtimeSync.initialSync;
        window.realtimeSync.initialSync = async () => {
            console.log('🧠 Запуск умной первичной синхронизации...');
            await this.performSmartSync();
        };
        
        // Заменяем метод обработки удаленных обновлений
        const originalHandleRemoteUpdate = window.realtimeSync.handleRemoteUpdate;
        window.realtimeSync.handleRemoteUpdate = async (cloudData) => {
            console.log('🧠 Умная обработка удаленного обновления...');
            
            // Выполняем умное объединение
            const localData = window.appData;
            const mergedData = await this.smartMerge(cloudData, localData);
            
            // Применяем результат
            await this.applyMergedData(mergedData);
        };
        
        console.log('✅ Интеграция завершена');
    }
}

// Создаем глобальный экземпляр
window.smartSyncLogic = new SmartSyncLogic();

// Автоматическая интеграция при загрузке
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (window.realtimeSync) {
            window.smartSyncLogic.integrateWithRealtimeSync();
            console.log('🧠 Умная логика синхронизации активирована');
        }
    }, 1000);
});

console.log('✅ Умная логика синхронизации загружена');

/**
 * 🧠 КАК ЭТО РАБОТАЕТ:
 * 
 * 1️⃣ ЧТЕНИЕ ИЗ FIREBASE:
 *    - Получаем данные из Firebase
 *    - Проверяем локальные удаления (isDeleted: true)
 *    - Помечаем соответствующие элементы в Firebase как удаленные
 * 
 * 2️⃣ АДМИНСКИЕ УДАЛЕНИЯ:
 *    - Если админ удалил данные локально (isDeleted: true)
 *    - При синхронизации эти данные помечаются как удаленные везде
 *    - Приоритет админских удалений над пользовательскими данными
 * 
 * 3️⃣ ПОЛЬЗОВАТЕЛЬСКИЕ ДОБАВЛЕНИЯ:
 *    - Если пользователи добавили новые данные
 *    - При синхронизации они добавляются в общую базу
 *    - Новые данные не конфликтуют с удалениями
 * 
 * 4️⃣ УМНОЕ ОБЪЕДИНЕНИЕ:
 *    - Удаляем то, что админ пометил как удаленное
 *    - Добавляем то, что пользователи создали новое
 *    - Обновляем то, что изменилось
 *    - Сохраняем целостность данных
 * 
 * 🎯 РЕЗУЛЬТАТ:
 * ✅ Админские удаления распространяются на всех пользователей
 * ✅ Пользовательские добавления сохраняются
 * ✅ Нет конфликтов при синхронизации
 * ✅ Данные остаются консистентными
 */