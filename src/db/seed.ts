import { env, logger } from '../config';
import { hashPassword } from '../lib';
import type { Queryable } from './database';

/**
 * Seed dữ liệu ban đầu.
 * Idempotent: chạy lại nhiều lần không tạo trùng và không ghi đè dữ liệu đã có.
 */
export async function seedDatabase(db: Queryable): Promise<void> {
    await seedAdmin(db);
}

async function seedAdmin(db: Queryable): Promise<void> {
    const email = env.SEED_ADMIN_EMAIL;

    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rowCount) {
        logger.info(`Tài khoản admin ${email} đã tồn tại, bỏ qua`);
        return;
    }

    const password = env.SEED_ADMIN_PASSWORD;
    if (!password) {
        throw new Error('Thiếu SEED_ADMIN_PASSWORD. Hãy cấu hình biến này để tạo tài khoản admin.');
    }

    const passwordHash = await hashPassword(password);
    await db.query(
        `INSERT INTO users (email, password_hash, display_name, role, email_verified_at)
         VALUES ($1, $2, 'Admin', 'ADMIN', now())
         ON CONFLICT (email) DO NOTHING`,
        [email, passwordHash],
    );
    logger.info(`Đã tạo tài khoản admin ${email}`);
}
