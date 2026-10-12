import { OAuth2Client } from 'google-auth-library';
import { env, logger } from '../config';

/** Thông tin về người dùng lấy từ ID token Google đã được xác thực. */
export interface GoogleProfile {
    /** Id cố định của tài khoản Google (email có thể đổi, `sub` thì không). */
    sub: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
}

export interface GoogleVerifier {
    /** Trả về hồ sơ, hoặc `null` nếu token không phải ID token Google hợp lệ cho ứng dụng này. */
    verify(idToken: string): Promise<GoogleProfile | null>;
}

/** Xác thực ID token bằng thư viện của Google: kiểm tra chữ ký, hạn dùng và `audience`. */
export function createGoogleVerifier(clientId: string): GoogleVerifier {
    const client = new OAuth2Client();
    return {
        async verify(idToken) {
            try {
                const ticket = await client.verifyIdToken({ idToken, audience: clientId });
                const payload = ticket.getPayload();
                if (!payload?.sub || !payload.email) return null;
                return {
                    sub: payload.sub,
                    email: payload.email.toLowerCase(),
                    emailVerified: payload.email_verified === true,
                    name: payload.name || null,
                };
            } catch (err) {
                logger.warn({ err }, 'google id token rejected');
                return null;
            }
        },
    };
}

let current: GoogleVerifier | undefined;

export function getGoogleVerifier(): GoogleVerifier | undefined {
    if (!current && env.GOOGLE_CLIENT_ID) current = createGoogleVerifier(env.GOOGLE_CLIENT_ID);
    return current;
}

export function setGoogleVerifier(verifier: GoogleVerifier | undefined): void {
    current = verifier;
}
