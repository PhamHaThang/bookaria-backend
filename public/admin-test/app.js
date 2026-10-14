const API = '/api/v1';
const MB = 1024 * 1024;

const state = {
    token: sessionStorage.getItem('bookariaAdminToken') ?? '',
    page: 1,
    totalPages: 1,
    libraryPage: 1,
    libraryTotalPages: 1,
    selectedUser: null,
    selectedBookId: null,
    view: 'dashboard',
};

const elements = {
    app: document.querySelector('#app-section'),
    auditActions: document.querySelector('#audit-actions'),
    books: document.querySelector('#book-list'),
    closeCreateUser: document.querySelector('#close-create-user'),
    closeDetail: document.querySelector('#close-detail'),
    closeEdit: document.querySelector('#close-edit'),
    closeModerationDetail: document.querySelector('#close-moderation-detail'),
    createCategoryForm: document.querySelector('#create-category-form'),
    createLibraryAssetForm: document.querySelector('#create-library-asset-form'),
    createUserDialog: document.querySelector('#create-user-dialog'),
    createUserForm: document.querySelector('#create-user-form'),
    dashboardUpdated: document.querySelector('#dashboard-updated'),
    dashboardView: document.querySelector('#dashboard-view'),
    detail: document.querySelector('#detail-card'),
    detailList: document.querySelector('#user-detail'),
    dialog: document.querySelector('#edit-dialog'),
    editForm: document.querySelector('#edit-form'),
    editUserLabel: document.querySelector('#edit-user-label'),
    filters: document.querySelector('#filters-form'),
    deleteCategoryForm: document.querySelector('#delete-category-form'),
    login: document.querySelector('#login-section'),
    loginForm: document.querySelector('#login-form'),
    libraryAssets: document.querySelector('#library-assets-body'),
    libraryAssetsMeta: document.querySelector('#library-assets-meta'),
    libraryFilters: document.querySelector('#library-filters'),
    libraryNext: document.querySelector('#library-next-page'),
    libraryPageLabel: document.querySelector('#library-page-label'),
    libraryPrevious: document.querySelector('#library-previous-page'),
    libraryView: document.querySelector('#library-view'),
    logout: document.querySelector('#logout-button'),
    message: document.querySelector('#message'),
    metricBooks: document.querySelector('#metric-books'),
    metricJobs: document.querySelector('#metric-jobs'),
    metricReports: document.querySelector('#metric-reports'),
    metricStorage: document.querySelector('#metric-storage'),
    metricUsers: document.querySelector('#metric-users'),
    moderationBooks: document.querySelector('#moderation-books-body'),
    moderationBooksMeta: document.querySelector('#moderation-books-meta'),
    moderationDetail: document.querySelector('#moderation-detail'),
    moderationDetailMeta: document.querySelector('#moderation-detail-meta'),
    moderationDetailTitle: document.querySelector('#moderation-detail-title'),
    moderationFilters: document.querySelector('#moderation-filters'),
    moderationPages: document.querySelector('#moderation-pages-body'),
    moderationQueue: document.querySelector('#moderation-queue-body'),
    moderationQueueMeta: document.querySelector('#moderation-queue-meta'),
    moderationReports: document.querySelector('#moderation-reports-body'),
    moderationView: document.querySelector('#moderation-view'),
    navLinks: document.querySelectorAll('.nav-link'),
    next: document.querySelector('#next-page'),
    openCreateUser: document.querySelector('#open-create-user'),
    pageLabel: document.querySelector('#page-label'),
    previous: document.querySelector('#previous-page'),
    publishedChart: document.querySelector('#published-chart'),
    refreshDashboard: document.querySelector('#refresh-dashboard'),
    refreshModeration: document.querySelector('#refresh-moderation'),
    refreshLibrary: document.querySelector('#refresh-library'),
    reinstateBook: document.querySelector('#reinstate-book'),
    dismissReports: document.querySelector('#dismiss-reports'),
    takedownBook: document.querySelector('#takedown-book'),
    users: document.querySelector('#users-body'),
    usersView: document.querySelector('#users-view'),
    updateCategoryForm: document.querySelector('#update-category-form'),
    categoryResult: document.querySelector('#category-result'),
};

elements.loginForm.addEventListener('submit', login);
elements.logout.addEventListener('click', logout);
elements.openCreateUser.addEventListener('click', () => elements.createUserDialog.showModal());
elements.closeCreateUser.addEventListener('click', () => elements.createUserDialog.close());
elements.createUserForm.addEventListener('submit', createUser);
elements.refreshDashboard.addEventListener('click', () => void loadDashboard());
elements.refreshModeration.addEventListener('click', () => void loadModeration());
elements.refreshLibrary.addEventListener('click', () => void loadLibraryAssets());
elements.createLibraryAssetForm.addEventListener('submit', createLibraryAsset);
elements.createCategoryForm.addEventListener('submit', createCategory);
elements.updateCategoryForm.addEventListener('submit', updateCategory);
elements.deleteCategoryForm.addEventListener('submit', deleteCategory);
elements.libraryFilters.addEventListener('submit', (event) => {
    event.preventDefault();
    state.libraryPage = 1;
    void loadLibraryAssets();
});
elements.libraryPrevious.addEventListener('click', () => {
    if (state.libraryPage > 1) {
        state.libraryPage -= 1;
        void loadLibraryAssets();
    }
});
elements.libraryNext.addEventListener('click', () => {
    if (state.libraryPage < state.libraryTotalPages) {
        state.libraryPage += 1;
        void loadLibraryAssets();
    }
});
elements.moderationFilters.addEventListener('submit', (event) => {
    event.preventDefault();
    void loadModerationBooks();
});
elements.closeModerationDetail.addEventListener('click', () => {
    state.selectedBookId = null;
    elements.moderationDetail.classList.add('hidden');
});
elements.takedownBook.addEventListener('click', () => void takeDownSelectedBook());
elements.reinstateBook.addEventListener('click', () => void reinstateSelectedBook());
elements.dismissReports.addEventListener('click', () => void dismissSelectedReports());
for (const link of elements.navLinks) {
    link.addEventListener('click', () => void openView(link.dataset.view));
}
elements.filters.addEventListener('submit', (event) => {
    event.preventDefault();
    state.page = 1;
    void loadUsers();
});
elements.previous.addEventListener('click', () => {
    if (state.page > 1) {
        state.page -= 1;
        void loadUsers();
    }
});
elements.next.addEventListener('click', () => {
    if (state.page < state.totalPages) {
        state.page += 1;
        void loadUsers();
    }
});
elements.closeDetail.addEventListener('click', () => elements.detail.classList.add('hidden'));
elements.closeEdit.addEventListener('click', () => elements.dialog.close());
elements.editForm.addEventListener('submit', updateUser);

if (state.token) {
    showApp();
    void openView('dashboard');
}

async function login(event) {
    event.preventDefault();
    const form = new FormData(elements.loginForm);
    try {
        const result = await api('/auth/login', {
            method: 'POST',
            body: {
                email: form.get('email'),
                password: form.get('password'),
                remember: form.get('remember') === 'on',
            },
            withAuth: false,
        });
        state.token = result.data.accessToken;
        sessionStorage.setItem('bookariaAdminToken', state.token);
        showApp();
        await openView('dashboard');
        showMessage(`Đã đăng nhập: ${result.data.user.displayName}`);
    } catch (error) {
        showError(error);
    }
}

async function logout() {
    try {
        await api('/auth/logout', { method: 'POST', withAuth: false });
    } catch {
        // Local logout must still work when the cookie has expired.
    }
    state.token = '';
    state.selectedUser = null;
    state.selectedBookId = null;
    sessionStorage.removeItem('bookariaAdminToken');
    elements.app.classList.add('hidden');
    elements.logout.classList.add('hidden');
    elements.login.classList.remove('hidden');
    elements.detail.classList.add('hidden');
    elements.moderationDetail.classList.add('hidden');
    elements.createUserDialog.close();
    elements.dialog.close();
    showMessage('Đã đăng xuất.');
}

async function openView(view) {
    state.view = ['users', 'moderation', 'library'].includes(view) ? view : 'dashboard';
    elements.dashboardView.classList.toggle('hidden', state.view !== 'dashboard');
    elements.libraryView.classList.toggle('hidden', state.view !== 'library');
    elements.moderationView.classList.toggle('hidden', state.view !== 'moderation');
    elements.usersView.classList.toggle('hidden', state.view !== 'users');
    for (const link of elements.navLinks) {
        const active = link.dataset.view === state.view;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }

    if (state.view === 'dashboard') await loadDashboard();
    else if (state.view === 'moderation') await loadModeration();
    else if (state.view === 'library') await loadLibraryAssets();
    else await loadUsers();
}

async function loadDashboard() {
    try {
        const { data } = await api('/admin/dashboard');
        elements.metricUsers.textContent = formatNumber(data.users);
        elements.metricBooks.textContent = formatNumber(data.publishedBooks);
        elements.metricStorage.textContent = formatBytes(data.storageUsedBytes);
        elements.metricJobs.textContent = formatNumber(data.failedJobs24h);
        elements.metricReports.textContent = formatNumber(data.openReports);
        elements.dashboardUpdated.textContent = `Cập nhật lúc ${new Date().toLocaleTimeString('vi-VN')}`;
        renderPublishedChart(data.publishedPerDay);
        renderAuditActions(data.auditActionsToday);
    } catch (error) {
        showError(error);
    }
}

function renderPublishedChart(days) {
    elements.publishedChart.replaceChildren();
    const max = Math.max(1, ...days.map((day) => day.count));
    for (const day of days) {
        const row = node('div', '', 'bar-row');
        const track = node('div', '', 'bar-track');
        const fill = node('span', '', 'bar-fill');
        fill.style.width = `${(day.count / max) * 100}%`;
        track.append(fill);
        row.append(
            node('span', formatDay(day.date)),
            track,
            node('span', formatNumber(day.count), 'bar-count'),
        );
        elements.publishedChart.append(row);
    }
}

function renderAuditActions(actions) {
    elements.auditActions.replaceChildren();
    if (!actions.length) {
        elements.auditActions.append(node('li', 'Chưa có hành vi quản trị hôm nay.'));
        return;
    }
    for (const item of actions) {
        const row = document.createElement('li');
        row.append(
            node('span', item.action.replaceAll('_', ' ')),
            node('span', formatNumber(item.count), 'badge'),
        );
        elements.auditActions.append(row);
    }
}

async function loadModeration() {
    await Promise.all([loadModerationQueue(), loadModerationBooks()]);
}

async function loadModerationQueue() {
    try {
        const result = await api('/admin/moderation?page=1&limit=20');
        elements.moderationQueueMeta.textContent = `${formatNumber(result.meta.total)} sách đang chờ`;
        elements.moderationQueue.replaceChildren();
        if (!result.data.length) {
            renderEmptyRow(elements.moderationQueue, 6, 'Không có báo cáo đang mở.');
            return;
        }
        for (const item of result.data) {
            const row = document.createElement('tr');
            row.append(
                cell(item.book.title),
                cell(item.book.author.displayName),
                cellWith(node('span', formatNumber(item.reportCount), 'badge')),
                cell(item.reasons.join(', ')),
                cell(formatDate(item.lastReportedAt)),
                cellWith(
                    button('Chi tiết', 'secondary', () => void showModerationBook(item.book.id)),
                ),
            );
            elements.moderationQueue.append(row);
        }
    } catch (error) {
        showError(error);
    }
}

async function loadModerationBooks() {
    const filters = new FormData(elements.moderationFilters);
    const params = new URLSearchParams({
        page: '1',
        limit: '20',
        visibility: String(filters.get('visibility') || 'PUBLIC'),
    });
    const q = String(filters.get('q') ?? '').trim();
    if (q) params.set('q', q);

    try {
        const result = await api(`/admin/books?${params}`);
        elements.moderationBooksMeta.textContent = `${formatNumber(result.meta.total)} sách phù hợp`;
        elements.moderationBooks.replaceChildren();
        if (!result.data.length) {
            renderEmptyRow(elements.moderationBooks, 7, 'Không có sách phù hợp.');
            return;
        }
        for (const book of result.data) {
            const row = document.createElement('tr');
            const title = document.createElement('td');
            title.append(
                node('span', book.title, 'user-name'),
                node('span', `${book.pageCount} trang`, 'user-email'),
            );
            row.append(
                title,
                cell(book.author.displayName),
                cellWith(node('span', book.status, 'badge')),
                cellWith(node('span', book.visibility, `badge ${book.takenDown ? 'locked' : ''}`)),
                cell(formatNumber(book.reportCount)),
                cell(formatDate(book.updatedAt)),
                cellWith(button('Chi tiết', 'secondary', () => void showModerationBook(book.id))),
            );
            elements.moderationBooks.append(row);
        }
    } catch (error) {
        showError(error);
    }
}

async function showModerationBook(bookId) {
    try {
        const { data } = await api(`/admin/books/${bookId}`);
        const book = data.book;
        state.selectedBookId = book.id;
        elements.moderationDetailTitle.textContent = book.title;
        elements.moderationDetailMeta.replaceChildren();
        const values = [
            ['Tác giả', book.author.displayName],
            ['Trạng thái', book.status],
            ['Hiển thị', book.visibility],
            ['Đã gỡ', book.takenDown ? 'Có' : 'Không'],
            ['Lý do gỡ', book.takenDownReason ?? '—'],
            ['Cập nhật', formatDate(book.updatedAt)],
        ];
        for (const [label, value] of values) {
            const item = document.createElement('div');
            item.append(node('dt', label), node('dd', value));
            elements.moderationDetailMeta.append(item);
        }

        elements.takedownBook.classList.toggle('hidden', book.takenDown);
        elements.reinstateBook.classList.toggle('hidden', !book.takenDown);
        elements.dismissReports.classList.toggle(
            'hidden',
            !data.reports.some((report) => report.status === 'OPEN'),
        );
        renderModerationPages(book.pages);
        renderModerationReports(data.reports);
        elements.moderationDetail.classList.remove('hidden');
        elements.moderationDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        showError(error);
    }
}

function renderModerationPages(pages) {
    elements.moderationPages.replaceChildren();
    if (!pages.length) {
        renderEmptyRow(elements.moderationPages, 6, 'Sách chưa có trang.');
        return;
    }
    for (const page of pages) {
        const thumbnail = page.thumbnailUrl
            ? externalLink('Mở ảnh', page.thumbnailUrl)
            : node('span', '—');
        const row = document.createElement('tr');
        row.append(
            cell(String(page.orderIndex + 1)),
            cell(page.title ?? '—'),
            cellWith(thumbnail),
            cell(page.markerNumber ? `${page.markerMode} #${page.markerNumber}` : page.markerMode),
            cell(page.markerScore ?? '—'),
            cell(formatNumber(page.objectCount)),
        );
        elements.moderationPages.append(row);
    }
}

function renderModerationReports(reports) {
    elements.moderationReports.replaceChildren();
    if (!reports.length) {
        renderEmptyRow(elements.moderationReports, 5, 'Sách chưa có báo cáo.');
        return;
    }
    for (const report of reports) {
        const row = document.createElement('tr');
        row.append(
            cell(report.reason),
            cell(report.note ?? '—'),
            cellWith(
                node('span', report.status, `badge ${report.status === 'OPEN' ? 'locked' : ''}`),
            ),
            cell(formatDate(report.createdAt)),
            cell(formatDate(report.handledAt)),
        );
        elements.moderationReports.append(row);
    }
}

async function takeDownSelectedBook() {
    if (!state.selectedBookId) return;
    const reason = prompt('Nhập lý do gỡ sách:');
    if (reason === null) return;
    if (!reason.trim()) {
        showMessage('Cần nhập lý do gỡ sách.', true);
        return;
    }
    try {
        const { data } = await api(`/admin/books/${state.selectedBookId}/takedown`, {
            method: 'POST',
            body: { reason: reason.trim() },
        });
        await refreshSelectedBook();
        showMessage(`Đã gỡ sách và xử lý ${data.resolvedReports} báo cáo.`);
    } catch (error) {
        showError(error);
    }
}

async function reinstateSelectedBook() {
    if (!state.selectedBookId) return;
    const note = prompt('Ghi chú khôi phục (có thể để trống):', '');
    if (note === null) return;
    try {
        await api(`/admin/books/${state.selectedBookId}/reinstate`, {
            method: 'POST',
            body: note.trim() ? { note: note.trim() } : {},
        });
        await refreshSelectedBook();
        showMessage('Đã khôi phục sách.');
    } catch (error) {
        showError(error);
    }
}

async function dismissSelectedReports() {
    if (!state.selectedBookId) return;
    const note = prompt('Ghi chú bỏ qua báo cáo (có thể để trống):', '');
    if (note === null) return;
    try {
        const { data } = await api(`/admin/books/${state.selectedBookId}/reports/dismiss`, {
            method: 'POST',
            body: note.trim() ? { note: note.trim() } : {},
        });
        await refreshSelectedBook();
        showMessage(`Đã bỏ qua ${data.dismissedReports} báo cáo.`);
    } catch (error) {
        showError(error);
    }
}

async function refreshSelectedBook() {
    const bookId = state.selectedBookId;
    await loadModeration();
    if (bookId) await showModerationBook(bookId);
}

async function loadLibraryAssets() {
    const filters = new FormData(elements.libraryFilters);
    const params = new URLSearchParams({
        page: String(state.libraryPage),
        limit: '20',
    });
    for (const key of ['q', 'type', 'categoryId']) {
        const value = String(filters.get(key) ?? '').trim();
        if (value) params.set(key, value);
    }

    try {
        const result = await api(`/admin/library/assets?${params}`);
        state.libraryTotalPages = Math.max(1, result.meta.totalPages);
        elements.libraryAssetsMeta.textContent = `${formatNumber(result.meta.total)} asset`;
        elements.libraryPageLabel.textContent = `Trang ${state.libraryPage}/${state.libraryTotalPages}`;
        elements.libraryPrevious.disabled = state.libraryPage <= 1;
        elements.libraryNext.disabled = state.libraryPage >= state.libraryTotalPages;
        renderLibraryAssets(result.data);
    } catch (error) {
        showError(error);
    }
}

function renderLibraryAssets(assets) {
    elements.libraryAssets.replaceChildren();
    if (!assets.length) {
        renderEmptyRow(elements.libraryAssets, 7, 'Không có asset thư viện phù hợp.');
        return;
    }

    for (const asset of assets) {
        const identity = document.createElement('td');
        identity.append(
            externalLink(asset.name, asset.url),
            node('span', `${asset.id} · ${asset.status}`, 'user-email'),
            node('span', asset.tags.join(', ') || 'Không có tag', 'user-email'),
        );
        const actions = node('div', '', 'actions');
        actions.append(
            button('Sửa', '', () => void editLibraryAsset(asset)),
            button('Xóa', 'danger', () => void removeLibraryAsset(asset)),
        );
        const row = document.createElement('tr');
        row.append(
            identity,
            cellWith(node('span', asset.type, 'badge')),
            cell(asset.license),
            cell(asset.authorName),
            cell(asset.categoryId ?? '—'),
            cell(formatBytes(asset.sizeBytes)),
            cellWith(actions),
        );
        elements.libraryAssets.append(row);
    }
}

async function createLibraryAsset(event) {
    event.preventDefault();
    const form = new FormData(elements.createLibraryAssetForm);
    const categoryId = String(form.get('categoryId') ?? '').trim();
    const sourceUrl = String(form.get('sourceUrl') ?? '').trim();
    try {
        const { data } = await api('/admin/library/assets', {
            method: 'POST',
            body: {
                assetId: String(form.get('assetId')).trim(),
                name: String(form.get('name')).trim(),
                license: String(form.get('license')).trim(),
                authorName: String(form.get('authorName')).trim(),
                tags: parseTags(form.get('tags')),
                ...(categoryId ? { categoryId } : {}),
                ...(sourceUrl ? { sourceUrl } : {}),
            },
        });
        elements.createLibraryAssetForm.reset();
        state.libraryPage = 1;
        await loadLibraryAssets();
        showMessage(`Đã thêm “${data.name}” vào thư viện.`);
    } catch (error) {
        showError(error);
    }
}

async function editLibraryAsset(asset) {
    const name = prompt('Tên asset:', asset.name);
    if (name === null) return;
    const license = prompt('License:', asset.license);
    if (license === null) return;
    const authorName = prompt('Tác giả gốc:', asset.authorName);
    if (authorName === null) return;
    const categoryId = prompt('Category ID (để trống để bỏ category):', asset.categoryId ?? '');
    if (categoryId === null) return;
    const sourceUrl = prompt('URL nguồn (để trống để xóa):', asset.sourceUrl ?? '');
    if (sourceUrl === null) return;
    const tags = prompt('Tags, phân cách bằng dấu phẩy:', asset.tags.join(', '));
    if (tags === null) return;
    if (!name.trim() || !license.trim() || !authorName.trim()) {
        showMessage('Tên, license và tác giả gốc không được để trống.', true);
        return;
    }

    try {
        await api(`/admin/library/assets/${asset.id}`, {
            method: 'PATCH',
            body: {
                name: name.trim(),
                license: license.trim(),
                authorName: authorName.trim(),
                categoryId: categoryId.trim() || null,
                sourceUrl: sourceUrl.trim() || null,
                tags: parseTags(tags),
            },
        });
        await loadLibraryAssets();
        showMessage('Đã cập nhật asset thư viện.');
    } catch (error) {
        showError(error);
    }
}

async function removeLibraryAsset(asset) {
    if (!confirm(`Xóa “${asset.name}” khỏi thư viện?`)) return;
    try {
        await api(`/admin/library/assets/${asset.id}`, { method: 'DELETE' });
        await loadLibraryAssets();
        showMessage('Đã xóa asset khỏi thư viện.');
    } catch (error) {
        showError(error);
    }
}

async function createCategory(event) {
    event.preventDefault();
    const form = new FormData(elements.createCategoryForm);
    const parentId = String(form.get('parentId') ?? '').trim();
    try {
        const { data } = await api('/admin/asset-categories', {
            method: 'POST',
            body: {
                name: String(form.get('name')).trim(),
                ...(parentId ? { parentId } : {}),
            },
        });
        elements.createCategoryForm.reset();
        elements.updateCategoryForm.elements.categoryId.value = data.id;
        elements.deleteCategoryForm.elements.categoryId.value = data.id;
        elements.createLibraryAssetForm.elements.categoryId.value = data.id;
        elements.categoryResult.textContent = `Category vừa tạo: ${data.name} · ${data.id}`;
        showMessage(`Đã tạo category “${data.name}”.`);
    } catch (error) {
        showError(error);
    }
}

async function updateCategory(event) {
    event.preventDefault();
    const form = new FormData(elements.updateCategoryForm);
    const categoryId = String(form.get('categoryId')).trim();
    const name = String(form.get('name') ?? '').trim();
    const parentId = String(form.get('parentId') ?? '').trim();
    const sortOrder = String(form.get('sortOrder') ?? '').trim();
    const body = {};
    if (name) body.name = name;
    if (parentId) body.parentId = parentId.toLowerCase() === 'null' ? null : parentId;
    if (sortOrder) body.sortOrder = Number(sortOrder);
    if (!Object.keys(body).length) {
        showMessage('Cần nhập ít nhất một trường category cần sửa.', true);
        return;
    }

    try {
        const { data } = await api(`/admin/asset-categories/${categoryId}`, {
            method: 'PATCH',
            body,
        });
        elements.categoryResult.textContent = `Category đã sửa: ${data.name} · ${data.id}`;
        showMessage('Đã cập nhật category.');
    } catch (error) {
        showError(error);
    }
}

async function deleteCategory(event) {
    event.preventDefault();
    const categoryId = String(new FormData(elements.deleteCategoryForm).get('categoryId')).trim();
    if (!confirm(`Xóa category ${categoryId}?`)) return;
    try {
        await api(`/admin/asset-categories/${categoryId}`, { method: 'DELETE' });
        elements.deleteCategoryForm.reset();
        elements.categoryResult.textContent = `Đã xóa category ${categoryId}`;
        showMessage('Đã xóa category.');
    } catch (error) {
        showError(error);
    }
}

async function createUser(event) {
    event.preventDefault();
    const form = new FormData(elements.createUserForm);
    try {
        const result = await api('/admin/users', {
            method: 'POST',
            body: {
                displayName: form.get('displayName'),
                email: form.get('email'),
                password: form.get('password'),
            },
        });
        elements.createUserDialog.close();
        elements.createUserForm.reset();
        state.page = 1;
        await loadUsers();
        showMessage(`Đã tạo người dùng ${result.data.email}.`);
    } catch (error) {
        showError(error);
    }
}

async function loadUsers() {
    const filters = new FormData(elements.filters);
    const params = new URLSearchParams({ page: String(state.page), limit: '20' });
    for (const key of ['q', 'role', 'status', 'sort']) {
        const value = String(filters.get(key) ?? '').trim();
        if (value) params.set(key, value);
    }

    try {
        const result = await api(`/admin/users?${params}`);
        renderUsers(result.data);
        state.totalPages = Math.max(1, result.meta.totalPages);
        elements.pageLabel.textContent = `Trang ${state.page}/${state.totalPages} · ${result.meta.total} người dùng`;
        elements.previous.disabled = state.page <= 1;
        elements.next.disabled = state.page >= state.totalPages;
    } catch (error) {
        showError(error);
    }
}

function renderUsers(users) {
    elements.users.replaceChildren();
    if (!users.length) {
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.textContent = 'Không có người dùng phù hợp.';
        const row = document.createElement('tr');
        row.append(cell);
        elements.users.append(row);
        return;
    }

    for (const user of users) {
        const row = document.createElement('tr');
        const identity = document.createElement('td');
        identity.append(
            node('span', user.displayName, 'user-name'),
            node('span', user.email, 'user-email'),
        );
        row.append(
            identity,
            cellWith(node('span', user.role, 'badge')),
            cellWith(
                node('span', user.status, `badge ${user.status === 'LOCKED' ? 'locked' : ''}`),
            ),
            cell(String(user.bookCount)),
            cell(`${formatMb(user.storage.usedBytes)} / ${formatMb(user.storage.quotaBytes)}`),
            cell(formatDate(user.updatedAt)),
            actionCell(user),
        );
        elements.users.append(row);
    }
}

function actionCell(user) {
    const wrapper = node('div', '', 'actions');
    const detail = button('Chi tiết', 'secondary', () => void showDetail(user.id));
    const edit = button('Sửa', '', () => openEdit(user));
    wrapper.append(detail, edit);
    if (user.status === 'ACTIVE') {
        wrapper.append(button('Khóa', 'danger', () => void lockUser(user)));
    }
    return cellWith(wrapper);
}

async function lockUser(user) {
    const reason = prompt(`Nhập lý do khóa ${user.displayName}:`);
    if (reason === null) return;
    if (!reason.trim()) {
        showMessage('Cần nhập lý do khóa tài khoản.', true);
        return;
    }

    try {
        await api(`/admin/users/${user.id}`, {
            method: 'PATCH',
            body: { status: 'LOCKED', reason: reason.trim() },
        });
        await loadUsers();
        if (!elements.detail.classList.contains('hidden')) await showDetail(user.id);
        showMessage(`Đã khóa ${user.displayName}.`);
    } catch (error) {
        showError(error);
    }
}

async function showDetail(userId) {
    try {
        const { data: user } = await api(`/admin/users/${userId}`);
        elements.detailList.replaceChildren();
        const values = [
            ['Tên', user.displayName],
            ['Email', user.email],
            ['Vai trò', user.role],
            ['Trạng thái', user.status],
            ['Email xác thực', user.emailVerified ? 'Đã xác thực' : 'Chưa xác thực'],
            ['Đơn vị', user.organization ?? '—'],
            [
                'Dung lượng',
                `${formatMb(user.storage.usedBytes)} / ${formatMb(user.storage.quotaBytes)}`,
            ],
            ['Đăng nhập cuối', formatDate(user.lastLoginAt)],
            ['Ngày tạo', formatDate(user.createdAt)],
        ];
        for (const [label, value] of values) {
            const item = document.createElement('div');
            item.append(node('dt', label), node('dd', value));
            elements.detailList.append(item);
        }

        elements.books.replaceChildren();
        if (!user.books.length) {
            elements.books.append(node('li', 'Người dùng chưa có sách.'));
        } else {
            for (const book of user.books) {
                elements.books.append(
                    node(
                        'li',
                        `${book.title} · ${book.status} · ${book.visibility} · ${book.pageCount} trang`,
                    ),
                );
            }
        }
        elements.detail.classList.remove('hidden');
        elements.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        showError(error);
    }
}

function openEdit(user) {
    state.selectedUser = user;
    elements.editUserLabel.textContent = `${user.displayName} · ${user.email}`;
    elements.editForm.elements.role.value = user.role;
    elements.editForm.elements.status.value = user.status;
    elements.editForm.elements.quotaMb.value = String(Math.round(user.storage.quotaBytes / MB));
    elements.editForm.elements.reason.value = '';
    elements.dialog.showModal();
}

async function updateUser(event) {
    event.preventDefault();
    const original = state.selectedUser;
    if (!original) return;

    const form = new FormData(elements.editForm);
    const role = String(form.get('role'));
    const status = String(form.get('status'));
    const quotaBytes = Number(form.get('quotaMb')) * MB;
    const reason = String(form.get('reason') ?? '').trim();
    const body = {};

    if (role !== original.role) body.role = role;
    if (status !== original.status) body.status = status;
    if (quotaBytes !== original.storage.quotaBytes) body.storageQuotaBytes = quotaBytes;
    if ((body.role || body.status) && !reason) {
        showMessage('Cần nhập lý do khi đổi vai trò hoặc trạng thái.', true);
        return;
    }
    if (reason) body.reason = reason;
    if (!Object.keys(body).some((key) => key !== 'reason')) {
        showMessage('Không có thay đổi để lưu.', true);
        return;
    }

    try {
        await api(`/admin/users/${original.id}`, { method: 'PATCH', body });
        elements.dialog.close();
        await loadUsers();
        if (!elements.detail.classList.contains('hidden')) await showDetail(original.id);
        showMessage('Đã cập nhật người dùng.');
    } catch (error) {
        showError(error);
    }
}

async function api(path, options = {}) {
    const headers = {};
    if (options.withAuth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error?.message ?? `HTTP ${response.status}`);
        error.details = payload.error?.details;
        throw error;
    }
    return payload;
}

function showApp() {
    elements.login.classList.add('hidden');
    elements.app.classList.remove('hidden');
    elements.logout.classList.remove('hidden');
}

function showError(error) {
    const details = Array.isArray(error.details)
        ? ` ${error.details.map((item) => `${item.path}: ${item.message}`).join('; ')}`
        : error.details
          ? ` ${JSON.stringify(error.details)}`
          : '';
    showMessage(`${error.message}${details}`, true);
}

function showMessage(text, isError = false) {
    elements.message.textContent = text;
    elements.message.classList.toggle('error', isError);
    elements.message.classList.remove('hidden');
}

function node(tag, text, className = '') {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
}

function cell(text) {
    return node('td', text);
}

function cellWith(child) {
    const result = document.createElement('td');
    result.append(child);
    return result;
}

function renderEmptyRow(body, colSpan, text) {
    const row = document.createElement('tr');
    const empty = cell(text);
    empty.colSpan = colSpan;
    row.append(empty);
    body.append(row);
}

function externalLink(text, url) {
    const result = node('a', text);
    result.href = url;
    result.target = '_blank';
    result.rel = 'noreferrer';
    return result;
}

function button(text, className, onClick) {
    const result = node('button', text, className);
    result.type = 'button';
    result.addEventListener('click', onClick);
    return result;
}

function parseTags(value) {
    return [
        ...new Set(
            String(value ?? '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
        ),
    ];
}

function formatMb(bytes) {
    return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
    return formatMb(bytes);
}

function formatNumber(value) {
    return new Intl.NumberFormat('vi-VN').format(value);
}

function formatDay(value) {
    return new Date(`${value}T00:00:00`).toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
    });
}

function formatDate(value) {
    return value ? new Date(value).toLocaleString('vi-VN') : '—';
}
