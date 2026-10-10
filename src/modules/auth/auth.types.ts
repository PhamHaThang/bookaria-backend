import type { AuthUser } from '../../schema';

export interface AuthResult {
    accessToken: string;
    expiresIn: number;
    user: AuthUser;
    refreshToken?: string;
    cookieMaxAgeMs?: number;
}
export interface UserRow {
    id: string;
    email: string;
    password_hash: string | null;
    display_name: string;
    role: 'AUTHOR' | 'ADMIN';
    status: 'ACTIVE' | 'LOCKED';
    email_verified_at: Date | null;
    failed_login_count: number;
    locked_until: Date | null;
}

export interface AuthSessionRow {
    id: string;
    user_id: string;
    refresh_token_hash: string;
    previous_token_hash: string | null;
    remember: boolean;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
}

export type AuthTokenType = 'VERIFY_EMAIL' | 'RESET_PASSWORD';
