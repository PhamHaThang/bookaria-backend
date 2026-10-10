import { createHash, randomBytes } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
