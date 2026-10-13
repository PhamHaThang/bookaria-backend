const API = '/api/v1';
const MB = 1024 * 1024;

const state = {
    token: sessionStorage.getItem('bookariaAdminToken') ?? '',
    page: 1,
    totalPages: 1,
    selectedUser: null,
};

const elements = {
    app: document.querySelector('#app-section'),
    books: document.querySelector('#book-list'),
    closeCreateUser: document.querySelector('#close-create-user'),
    closeDetail: document.querySelector('#close-detail'),
    closeEdit: document.querySelector('#close-edit'),
    createUserDialog: document.querySelector('#create-user-dialog'),
    createUserForm: document.querySelector('#create-user-form'),
    detail: document.querySelector('#detail-card'),
    detailList: document.querySelector('#user-detail'),
    dialog: document.querySelector('#edit-dialog'),
    editForm: document.querySelector('#edit-form'),
    editUserLabel: document.querySelector('#edit-user-label'),
    filters: document.querySelector('#filters-form'),
    login: document.querySelector('#login-section'),
    loginForm: document.querySelector('#login-form'),
    logout: document.querySelector('#logout-button'),
    message: document.querySelector('#message'),
    next: document.querySelector('#next-page'),
    openCreateUser: document.querySelector('#open-create-user'),
    pageLabel: document.querySelector('#page-label'),
    previous: document.querySelector('#previous-page'),
    users: document.querySelector('#users-body'),
};

elements.loginForm.addEventListener('submit', login);
elements.logout.addEventListener('click', logout);
elements.openCreateUser.addEventListener('click', () => elements.createUserDialog.showModal());
elements.closeCreateUser.addEventListener('click', () => elements.createUserDialog.close());
elements.createUserForm.addEventListener('submit', createUser);
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
    void loadUsers();
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
        await loadUsers();
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
    sessionStorage.removeItem('bookariaAdminToken');
    elements.app.classList.add('hidden');
    elements.logout.classList.add('hidden');
    elements.login.classList.remove('hidden');
    elements.detail.classList.add('hidden');
    elements.createUserDialog.close();
    elements.dialog.close();
    showMessage('Đã đăng xuất.');
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

function button(text, className, onClick) {
    const result = node('button', text, className);
    result.type = 'button';
    result.addEventListener('click', onClick);
    return result;
}

function formatMb(bytes) {
    return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

function formatDate(value) {
    return value ? new Date(value).toLocaleString('vi-VN') : '—';
}
