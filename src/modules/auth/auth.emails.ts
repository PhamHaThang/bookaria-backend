import { env } from '../../config';
import type { Mail } from '../../lib';
import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_HOURS } from './auth.constants';

export function verifyEmailMail(to: string, displayName: string, token: string): Mail {
    const link = `${env.STUDIO_URL}/verify-email?token=${encodeURIComponent(token)}`;
    return {
        to,
        subject: 'Xác minh địa chỉ email của bạn',
        text: `Xin chào ${displayName},\n\nVui lòng nhấp vào liên kết sau để xác minh địa chỉ email của bạn:\n\n${link}\n\nLiên kết này sẽ hết hạn sau ${VERIFY_EMAIL_TTL_HOURS} giờ.\n\nNếu bạn không yêu cầu xác minh email, vui lòng bỏ qua email này.`,
    };
}

export function resetPasswordMail(to: string, displayName: string, token: string): Mail {
    const link = `${env.STUDIO_URL}/reset-password?token=${encodeURIComponent(token)}`;
    return {
        to,
        subject: 'Đặt lại mật khẩu của bạn',
        text: `Xin chào ${displayName},\n\nVui lòng nhấp vào liên kết sau để đặt lại mật khẩu của bạn:\n\n${link}\n\nLiên kết này sẽ hết hạn sau ${RESET_PASSWORD_TTL_MINUTES} phút.\n\nNếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.`,
    };
}
