import { hash } from 'bcryptjs';
import type pg from 'pg';
import { env, logger } from '../config';

/** Mật khẩu admin mặc định khi chạy seed ở môi trường không phải production. */
const DEV_ADMIN_PASSWORD = 'admin123';

/**
 * Seed dữ liệu ban đầu.
 * Idempotent: chạy lại nhiều lần không tạo trùng và không ghi đè dữ liệu đã có.
 */
export async function seedDatabase(db: pg.Pool | pg.PoolClient): Promise<void> {
    await seedAdmin(db);
}

async function seedAdmin(db: pg.Pool | pg.PoolClient): Promise<void> {
    const email = env.SEED_ADMIN_EMAIL;

    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rowCount) {
        logger.info(`Tài khoản admin ${email} đã tồn tại, bỏ qua`);
        return;
    }

    let password = env.SEED_ADMIN_PASSWORD;
    if (!password) {
        if (env.NODE_ENV === 'production') {
            throw new Error(
                'Thiếu SEED_ADMIN_PASSWORD: production không có mật khẩu admin mặc định',
            );
        }
        password = DEV_ADMIN_PASSWORD;
        logger.warn('Chưa đặt SEED_ADMIN_PASSWORD, dùng mật khẩu mặc định cho môi trường dev');
    }

    const passwordHash = await hash(password, env.BCRYPT_ROUNDS);
    await db.query(
        `INSERT INTO users (email, password_hash, display_name, role, email_verified_at)
         VALUES ($1, $2, 'Admin', 'ADMIN', now())
         ON CONFLICT (email) DO NOTHING`,
        [email, passwordHash],
    );
    logger.info(`Đã tạo tài khoản admin ${email}`);
}
