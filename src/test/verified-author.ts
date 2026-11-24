import { pool } from '../db';

/** Provision verified authors for tests that exercise Studio rather than account setup. */
export async function verifyFixtureEmail(userId: string): Promise<void> {
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
}
