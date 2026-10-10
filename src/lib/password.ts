import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config';

export const hashPassword = async (plain: string): Promise<string> =>
    bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> =>
    bcrypt.compare(plain, hash);

let dummyHash: Promise<string> | undefined;
const getDummyHash = () => {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    return dummyHash;
};

export const warmUpPasswordCheck = async (): Promise<void> => {
    await getDummyHash();
};

/**
 * Spends the same time as a real password check. Used when the email does not exist, so that
 * "no such account" and "wrong password" cannot be told apart by how long the answer takes.
 */
export async function spendPasswordCheckTime(plain: string): Promise<void> {
    await bcrypt.compare(plain, await getDummyHash());
}
