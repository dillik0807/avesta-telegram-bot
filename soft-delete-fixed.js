/**
 * 🗑️ СИСТЕМА МЯГКОГО УДАЛЕНИЯ (ИСПРАВЛЕННАЯ ВЕРСИЯ)
 * 
 * Функции с правильными именами, которые заменяют старые функции удаления
 * Теперь кнопки "Удалить" будут работать с мягким удалением
 */

// ==================== ОСНОВНЫЕ ФУНКЦИИ МЯГКОГО УДАЛЕНИЯ ====================

/**
 * Мягкое удаление клиента (заменяет старую функцию deleteClient)
 */
function deleteClient(index) {
    if (!confirm('Вы уверены, что хотите удалить этого клиента?')) return;
    
    const client = appData.clients[index];
    if (!client) return;
    
    // Если это строка, конвертируем в объект
    if (typeof client === 'string') {
        appData.clients[index] = {
            name: client,
            isDeleted: true,
            deletedAt: Date.now(),
            deletedBy: currentUser?.username || 'unknown'
        };
    } else {
        // Если уже объект, просто добавляем флаг
        appData.clients[index].isDeleted = true;
        appData.clients[index].deletedAt = Date.now();
        appData.clients[index].deletedBy = currentUser?.username || 'unknown';
    }
    
    console.log('🗑️ Клиент помечен как удаленный:', client);
    
    // Помечаем данные как измененные для умной синхронизации
    markDataAsModified();
    
    saveData();
    updateClientDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление товара (заменяет старую функцию deleteProduct)
 */
function deleteProduct(index) {
    if (!confirm('Вы уверены, что хотите удалить этот товар?')) return;
    
    const product = appData.products[index];
    if (!product) return;
    
    // Создаем объект с флагом удаления
    appData.products[index] = {
        name: product,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: currentUser?.username || 'unknown'
    };
    
    console.log('🗑️ Товар помечен как удаленный:', product);
    
    markDataAsModified();
    saveData();
    updateProductDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление фирмы (заменяет старую функцию deleteCompany)
 */
function deleteCompany(index) {
    if (!confirm('Вы уверены, что хотите удалить эту фирму?')) return;
    
    const company = appData.companies[index];
    if (!company) return;
    
    appData.companies[index] = {
        name: company,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: currentUser?.username || 'unknown'
    };
    
    console.log('🗑️ Фирма помечена как удаленная:', company);
    
    markDataAsModified();
    saveData();
    updateCompanyDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление склада (заменяет старую функцию deleteWarehouse)
 */
function deleteWarehouse(index) {
    if (!confirm('Вы уверены, что хотите удалить этот склад?')) return;
    
    const warehouse = appData.warehouses[index];
    if (!warehouse) return;
    
    appData.warehouses[index] = {
        name: warehouse,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: currentUser?.username || 'unknown'
    };
    
    console.log('🗑️ Склад помечен как удаленный:', warehouse);
    
    markDataAsModified();
    saveData();
    updateWarehouseDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление группы складов (заменяет старую функцию deleteWarehouseGroup)
 */
function deleteWarehouseGroup(index) {
    if (!confirm('Вы уверены, что хотите удалить эту подгруппу?')) return;
    
    const group = appData.warehouseGroups[index];
    if (!group) return;
    
    appData.warehouseGroups[index] = {
        name: group,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: currentUser?.username || 'unknown'
    };
    
    console.log('🗑️ Группа складов помечена как удаленная:', group);
    
    markDataAsModified();
    saveData();
    updateWarehouseGroupDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление коалиции (заменяет старую функцию deleteCoalition)
 */
function deleteCoalition(index) {
    if (!confirm('Вы уверены, что хотите удалить эту коалицу?')) return;
    
    const coalition = appData.coalitions[index];
    if (!coalition) return;
    
    appData.coalitions[index] = {
        name: coalition,
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: currentUser?.username || 'unknown'
    };
    
    console.log('🗑️ Коалиция помечена как удаленная:', coalition);
    
    markDataAsModified();
    saveData();
    updateCoalitionDropdowns();
    updateManagementLists();
}

/**
 * Мягкое удаление пользователя (заменяет старую функцию deleteUser)
 */
function deleteUser(index) {
    if (!confirm('Вы уверены, что хотите удалить этого пользователя?')) return;
    
    const user = appData.users[index];
    if (!user) return;
    
    // Пользователи уже объекты, просто добавляем флаг
    appData.users[index].isDeleted = true;
    appData.users[index].deletedAt = Date.now();
    appData.users[index].deletedBy = currentUser?.username || 'unknown';
    
    console.log('🗑️ Пользователь помечен как удаленный:', user.username);
    
    markDataAsModified();
    saveData();
    updateUsersTable();
}

/**
 * Мягкое удаление записи дохода (заменяет старую функцию deleteIncome)
 */
function deleteIncome(id) {
    if (currentUser.role !== 'admin') {
        alert('Только администратор может удалять записи!');
        return;
    }

    if (!confirm('Вы уверены, что хотите удалить эту запись?')) return;

    const yearData = getCurrentYearData();
    const income = yearData.income.find(i => i.id === id);
    
    if (income) {
        income.isDeleted = true;
        income.deletedAt = Date.now();
        income.deletedBy = currentUser.username;
        
        console.log('🗑️ Запись дохода помечена как удаленная:', id);
        
        markDataAsModified();
        saveData();
        updateIncomeTable();
        updateStockBalanceTable();
    }
}

/**
 * Мягкое удаление записи расхода (заменяет старую функцию deleteExpense)
 */
function deleteExpense(id) {
    if (currentUser.role !== 'admin') {
        alert('Только администратор может удалять записи!');
        return;
    }

    if (!confirm('Вы уверены, что хотите удалить эту запись?')) return;

    const yearData = getCurrentYearData();
    const expense = yearData.expense.find(e => e.id === id);
    
    if (expense) {
        expense.isDeleted = true;
        expense.deletedAt = Date.now();
        expense.deletedBy = currentUser.username;
        
        console.log('🗑️ Запись расхода помечена как удаленная:', id);
        
        markDataAsModified();
        saveData();
        updateExpenseTable();
        updateStockBalanceTable();
    }
}

/**
 * Мягкое удаление записи погашения (заменяет старую функцию deletePayment)
 */
function deletePayment(id) {
    if (currentUser.role !== 'admin') {
        alert('Только администратор может удалять записи!');
        return;
    }

    if (!confirm('Вы уверены, что хотите удалить эту запись?')) return;

    const yearData = getCurrentYearData();
    const payment = yearData.payments.find(p => p.id === id);
    
    if (payment) {
        payment.isDeleted = true;
        payment.deletedAt = Date.now();
        payment.deletedBy = currentUser.username;
        
        console.log('🗑️ Запись погашения помечена как удаленная:', id);
        
        markDataAsModified();
        saveData();
        updatePaymentTable();
    }
}

/**
 * Мягкое удаление партнера (заменяет старую функцию deletePartner)
 */
function deletePartner(id) {
    if (!confirm('Вы уверены, что хотите удалить эту запись?')) return;

    const yearData = getCurrentYearData();
    const partner = yearData.partners.find(p => p.id === id);
    
    if (partner) {
        partner.isDeleted = true;
        partner.deletedAt = Date.now();
        partner.deletedBy = currentUser?.username || 'unknown';
        
        console.log('🗑️ Партнер помечен как удаленный:', id);
        
        markDataAsModified();
        saveData();
        updatePartnerTable();
    }
}

// ==================== ИНТЕГРАЦИЯ С УМНОЙ СИНХРОНИЗАЦИЕЙ ====================

/**
 * Пометить данные как измененные для умной синхронизации
 */
function markDataAsModified() {
    if (window.appData) {
        window.appData.lastModified = Date.now();
        window.appData.lastModifiedBy = window.currentUser?.username || 'unknown';
        
        // Уведомляем умную синхронизацию о изменениях
        if (window.smartSyncLogic) {
            console.log('🧠 Уведомляем умную синхронизацию об изменениях');
        }
    }
}

console.log('✅ Исправленная система мягкого удаления загружена');
console.log('🔧 Функции удаления заменены на мягкое удаление');

/**
 * 🎯 ИСПРАВЛЕНИЕ ПРОБЛЕМЫ:
 * 
 * ❌ БЫЛО:
 * - Кнопки вызывали deleteClient(), deleteProduct() и т.д.
 * - Но мы переименовали функции в softDeleteClient(), softDeleteProduct()
 * - Поэтому кнопки не работали
 * 
 * ✅ СТАЛО:
 * - Функции названы правильно: deleteClient(), deleteProduct() и т.д.
 * - Кнопки работают с мягким удалением
 * - Данные помечаются как isDeleted: true
 * - Интеграция с умной синхронизацией работает
 */