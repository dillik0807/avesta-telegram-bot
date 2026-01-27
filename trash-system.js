// ===== СИСТЕМА КОРЗИНЫ =====
// Файл: trash-system.js
// Описание: Система корзины для восстановления удаленных данных

// Загрузка данных корзины
function loadTrashData() {
    console.log('🗑️ Загрузка данных корзины...');
    
    const yearData = getCurrentYearData();
    console.log('📅 Данные года для корзины:', yearData);
    
    const trashData = [];
    
    // Собираем все удаленные записи
    if (yearData.income) {
        const deletedIncome = yearData.income.filter(item => item.isDeleted);
        console.log('🗑️ Найдено удаленных приходов:', deletedIncome.length);
        console.log('🗑️ Все приходы (первые 5):', yearData.income.slice(0, 5).map(i => ({
            id: i.id,
            idType: typeof i.id,
            isDeleted: i.isDeleted,
            date: i.date,
            company: i.company
        })));
        
        deletedIncome.forEach(item => {
            console.log('📝 Удаленный приход:', { 
                id: item.id, 
                idType: typeof item.id,
                date: item.date, 
                company: item.company, 
                product: item.product,
                isDeleted: item.isDeleted
            });
            trashData.push({
                type: 'income',
                typeName: 'Приход',
                data: item,
                deletedAt: item.deletedAt,
                deletedBy: item.deletedBy,
                displayText: `${item.date || 'н/д'} - ${item.company || 'н/д'} - ${item.product || 'н/д'} (${item.quantity || 'н/д'} ${item.unit || 'шт'})`
            });
        });
    }
    
    if (yearData.expense) {
        const deletedExpense = yearData.expense.filter(item => item.isDeleted);
        console.log('🗑️ Найдено удаленных расходов:', deletedExpense.length);
        
        deletedExpense.forEach(item => {
            console.log('📝 Удаленный расход:', { id: item.id, date: item.date, client: item.client, product: item.product });
            trashData.push({
                type: 'expense',
                typeName: 'Расход',
                data: item,
                deletedAt: item.deletedAt,
                deletedBy: item.deletedBy,
                displayText: `${item.date || 'н/д'} - ${item.client || 'н/д'} - ${item.product || 'н/д'} (${item.quantity || 'н/д'} ${item.unit || 'шт'})`
            });
        });
    }
    
    if (yearData.payments) {
        const deletedPayments = yearData.payments.filter(item => item.isDeleted);
        console.log('🗑️ Найдено удаленных погашений:', deletedPayments.length);
        
        deletedPayments.forEach(item => {
            console.log('📝 Удаленное погашение:', { id: item.id, date: item.date, client: item.client, amount: item.amount });
            trashData.push({
                type: 'payment',
                typeName: 'Погашения',
                data: item,
                deletedAt: item.deletedAt,
                deletedBy: item.deletedBy,
                displayText: `${item.date || 'н/д'} - ${item.client || 'н/д'} - ${item.amount || 'н/д'} сом`
            });
        });
    }
    
    // Сортируем по дате удаления (новые сверху)
    trashData.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    
    console.log('🗑️ Всего элементов в корзине:', trashData.length);
    console.log('🗑️ Данные корзины:', trashData);
    
    return trashData;
}

// Отображение данных корзины
function updateTrashTable() {
    console.log('🔄 Обновление таблицы корзины...');
    
    const trashData = loadTrashData();
    const tbody = document.getElementById('trashTableBody');
    
    if (!tbody) {
        console.error('❌ Элемент trashTableBody не найден!');
        return;
    }
    
    console.log('📋 Очистка таблицы корзины...');
    tbody.innerHTML = '';
    
    console.log('📝 Добавление записей в таблицу:', trashData.length);
    
    trashData.forEach((item, index) => {
        console.log(`📝 Добавляем запись ${index + 1}:`, { 
            type: item.type, 
            id: item.data.id, 
            displayText: item.displayText 
        });
        
        const row = document.createElement('tr');
        row.className = 'border-b hover:bg-gray-50';
        
        const deletedDate = item.deletedAt ? new Date(item.deletedAt).toLocaleString('ru-RU') : 'Неизвестно';
        
        row.innerHTML = `
            <td class="p-3">
                <span class="px-2 py-1 rounded text-xs font-medium ${getTypeColor(item.type)}">
                    ${item.typeName}
                </span>
            </td>
            <td class="p-3">${item.displayText}</td>
            <td class="p-3">${deletedDate}</td>
            <td class="p-3">${item.deletedBy || 'Неизвестно'}</td>
            <td class="p-3">
                <button onclick="restoreFromTrash('${item.type}', '${item.data.id}')" 
                        class="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700 mr-2">
                    Восстановить
                </button>
                <button onclick="permanentDelete('${item.type}', '${item.data.id}')" 
                        class="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700">
                    Удалить навсегда
                </button>
            </td>
        `;
        
        console.log(`✅ Кнопка восстановления для ${item.type} ID ${item.data.id} создана`);
        
        tbody.appendChild(row);
    });
    
    console.log('📊 Обновление статистики корзины...');
    // Обновляем статистику
    updateTrashStats(trashData);
    
    console.log('✅ Таблица корзины обновлена успешно');
}

// Цвета для типов данных
function getTypeColor(type) {
    const colors = {
        'income': 'bg-green-100 text-green-800',
        'expense': 'bg-red-100 text-red-800',
        'payment': 'bg-blue-100 text-blue-800',
        'client': 'bg-purple-100 text-purple-800',
        'product': 'bg-yellow-100 text-yellow-800',
        'company': 'bg-indigo-100 text-indigo-800',
        'warehouse': 'bg-gray-100 text-gray-800'
    };
    return colors[type] || 'bg-gray-100 text-gray-800';
}

// Обновление статистики корзины
function updateTrashStats(trashData) {
    const stats = {
        total: trashData.length,
        income: trashData.filter(item => item.type === 'income').length,
        expense: trashData.filter(item => item.type === 'expense').length,
        other: trashData.filter(item => !['income', 'expense'].includes(item.type)).length
    };
    
    const totalElement = document.getElementById('trashTotalItems');
    const incomeElement = document.getElementById('trashIncomeCount');
    const expenseElement = document.getElementById('trashExpenseCount');
    const otherElement = document.getElementById('trashOtherCount');
    
    if (totalElement) totalElement.textContent = stats.total;
    if (incomeElement) incomeElement.textContent = stats.income;
    if (expenseElement) expenseElement.textContent = stats.expense;
    if (otherElement) otherElement.textContent = stats.other;
}

// Универсальная функция поиска записи по ID
function findItemById(yearData, type, id) {
    console.log('🔍 Универсальный поиск записи:', { type, id, idType: typeof id });
    
    let array;
    switch (type) {
        case 'income':
            array = yearData.income;
            break;
        case 'expense':
            array = yearData.expense;
            break;
        case 'payment':
            array = yearData.payments;
            break;
        default:
            console.error('❌ Неизвестный тип:', type);
            return null;
    }
    
    if (!array || !Array.isArray(array)) {
        console.error('❌ Массив не найден или не является массивом:', array);
        return null;
    }
    
    console.log('📊 Размер массива:', array.length);
    
    // Поиск по точному совпадению (строка)
    let item = array.find(i => i.id === id);
    if (item) {
        console.log('✅ Найдено по строковому ID:', item);
        return item;
    }
    
    // Поиск по числовому ID
    const numericId = parseInt(id);
    if (!isNaN(numericId)) {
        item = array.find(i => i.id === numericId);
        if (item) {
            console.log('✅ Найдено по числовому ID:', item);
            return item;
        }
    }
    
    // Поиск по нестрогому сравнению
    item = array.find(i => i.id == id);
    if (item) {
        console.log('✅ Найдено по нестрогому сравнению:', item);
        return item;
    }
    
    // Поиск среди всех записей (показать что есть)
    console.log('🔍 Первые 10 ID в массиве:', array.slice(0, 10).map(i => ({
        id: i.id,
        idType: typeof i.id,
        isDeleted: i.isDeleted
    })));
    
    console.log('❌ Запись не найдена ни одним способом');
    return null;
}

// Восстановление из корзины
function restoreFromTrash(type, id) {
    console.log('🔄 Попытка восстановления:', { type, id });
    
    if (!confirm('Восстановить эту запись?')) return;
    
    const yearData = getCurrentYearData();
    console.log('📅 Данные года:', yearData);
    
    // Используем универсальную функцию поиска
    let item = findItemById(yearData, type, id);
    
    if (!item) {
        console.error('❌ Запись не найдена:', { type, id });
        alert('Ошибка: запись не найдена!');
        return;
    }
    
    console.log('📝 Найденная запись:', item);
    console.log('🗑️ Статус isDeleted:', item.isDeleted);
    
    if (item) {
        // Восстанавливаем запись
        delete item.isDeleted;
        delete item.deletedAt;
        delete item.deletedBy;
        
        console.log(`✅ Восстановлена запись ${type}:`, id);
        console.log('📝 Запись после восстановления:', item);
        
        saveData();
        updateTrashTable();
        
        // Обновляем соответствующие таблицы
        if (type === 'income') {
            if (typeof updateIncomeTable === 'function') updateIncomeTable();
            if (typeof initializeIncomeFilters === 'function') {
                setTimeout(() => {
                    initializeIncomeFilters();
                    initializeIncomeMultiSelectFilters();
                }, 100);
            }
        }
        
        if (type === 'expense') {
            if (typeof updateExpenseTable === 'function') updateExpenseTable();
            if (typeof initializeExpenseFilters === 'function') {
                setTimeout(() => {
                    initializeExpenseFilters();
                }, 100);
            }
        }
        
        if (type === 'payment') {
            if (typeof updatePaymentsTable === 'function') updatePaymentsTable();
            if (typeof updatePaymentFilterOptions === 'function') updatePaymentFilterOptions();
        }
        
        // Обновляем все связанные таблицы и отчеты
        if (typeof updateStockBalanceTable === 'function') updateStockBalanceTable();
        if (typeof updateBalanceSummary === 'function') updateBalanceSummary();
        if (typeof updateWagonSummary === 'function') updateWagonSummary();
        if (typeof updateDebtReport === 'function') updateDebtReport();
        if (typeof updateDashboard === 'function') updateDashboard();
        
        // Обновляем выпадающие списки
        if (typeof updateDropdowns === 'function') updateDropdowns();
        
        // Принудительно обновляем текущую секцию
        const currentSection = document.querySelector('.content-section:not(.hidden)');
        if (currentSection) {
            const sectionId = currentSection.id;
            console.log('🔄 Принудительное обновление текущей секции:', sectionId);
            
            // Обновляем текущую секцию
            if (sectionId === 'income' && type === 'income') {
                setTimeout(() => {
                    updateIncomeTable();
                    initializeIncomeFilters();
                    initializeIncomeMultiSelectFilters();
                }, 200);
            }
            if (sectionId === 'expense' && type === 'expense') {
                setTimeout(() => {
                    updateExpenseTable();
                    initializeExpenseFilters();
                }, 200);
            }
            if (sectionId === 'payments' && type === 'payment') {
                setTimeout(() => {
                    updatePaymentsTable();
                    updatePaymentFilterOptions();
                }, 200);
            }
        }
        
        console.log('🎉 Восстановление завершено успешно');
        alert('Запись успешно восстановлена!');
    }
}

// Окончательное удаление
function permanentDelete(type, id) {
    if (!confirm('ВНИМАНИЕ! Это действие удалит запись навсегда и не может быть отменено. Продолжить?')) return;
    
    const yearData = getCurrentYearData();
    
    switch (type) {
        case 'income':
            if (yearData.income) {
                yearData.income = yearData.income.filter(i => i.id !== id);
            }
            break;
        case 'expense':
            if (yearData.expense) {
                yearData.expense = yearData.expense.filter(e => e.id !== id);
            }
            break;
        case 'payment':
            if (yearData.payments) {
                yearData.payments = yearData.payments.filter(p => p.id !== id);
            }
            break;
    }
    
    console.log(`🗑️ Окончательно удалена запись ${type}:`, id);
    
    saveData();
    updateTrashTable();
    alert('Запись окончательно удалена!');
}

// Применение фильтров корзины
function applyTrashFilters() {
    const typeFilter = document.getElementById('trashTypeFilter')?.value || '';
    const dateFilter = document.getElementById('trashDateFilter')?.value || '';
    
    const trashData = loadTrashData();
    let filteredData = trashData;
    
    // Фильтр по типу
    if (typeFilter) {
        filteredData = filteredData.filter(item => item.type === typeFilter);
    }
    
    // Фильтр по дате
    if (dateFilter) {
        const filterDate = new Date(dateFilter);
        filteredData = filteredData.filter(item => {
            if (!item.deletedAt) return false;
            const itemDate = new Date(item.deletedAt);
            return itemDate.toDateString() === filterDate.toDateString();
        });
    }
    
    // Обновляем таблицу с отфильтрованными данными
    const tbody = document.getElementById('trashTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    filteredData.forEach(item => {
        const row = document.createElement('tr');
        row.className = 'border-b hover:bg-gray-50';
        
        const deletedDate = item.deletedAt ? new Date(item.deletedAt).toLocaleString('ru-RU') : 'Неизвестно';
        
        row.innerHTML = `
            <td class="p-3">
                <span class="px-2 py-1 rounded text-xs font-medium ${getTypeColor(item.type)}">
                    ${item.typeName}
                </span>
            </td>
            <td class="p-3">${item.displayText}</td>
            <td class="p-3">${deletedDate}</td>
            <td class="p-3">${item.deletedBy || 'Неизвестно'}</td>
            <td class="p-3">
                <button onclick="restoreFromTrash('${item.type}', '${item.data.id}')" 
                        class="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700 mr-2">
                    Восстановить
                </button>
                <button onclick="permanentDelete('${item.type}', '${item.data.id}')" 
                        class="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700">
                    Удалить навсегда
                </button>
            </td>
        `;
        
        tbody.appendChild(row);
    });
    
    updateTrashStats(filteredData);
}

// Очистка всей корзины
function clearTrash() {
    if (!confirm('ВНИМАНИЕ! Это действие окончательно удалит ВСЕ данные из корзины. Продолжить?')) return;
    
    const yearData = getCurrentYearData();
    
    // Удаляем все помеченные как удаленные записи
    if (yearData.income) {
        yearData.income = yearData.income.filter(item => !item.isDeleted);
    }
    if (yearData.expense) {
        yearData.expense = yearData.expense.filter(item => !item.isDeleted);
    }
    if (yearData.payments) {
        yearData.payments = yearData.payments.filter(item => !item.isDeleted);
    }
    
    console.log('🗑️ Корзина полностью очищена');
    
    saveData();
    updateTrashTable();
    alert('Корзина очищена!');
}

// Инициализация корзины при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
    console.log('🗑️ Система корзины инициализирована');
});