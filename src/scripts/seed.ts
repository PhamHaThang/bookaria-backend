import { logger } from '../config';
import { pool } from '../db';
import { seedDatabase } from '../db/seed';

try {
    await seedDatabase(pool);
    logger.info('Seed dữ liệu hoàn tất');
} catch (err) {
    logger.error({ err }, 'Seed dữ liệu thất bại');
    process.exitCode = 1;
} finally {
    await pool.end();
}
