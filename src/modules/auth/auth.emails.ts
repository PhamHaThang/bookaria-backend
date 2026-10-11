import { env } from '../../config';
import type { Mail } from '../../lib';
import { RESET_PASSWORD_TTL_MINUTES, VERIFY_EMAIL_TTL_HOURS } from './auth.constants';

/** Thay thế ký tự đặc biệt để chèn vào HTML. */
export function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
interface Content {
    displayName: string;
    intro: string[];
    action?: {
        label: string;
        url: string;
    };
    outro: string[];
}
const BRAND_COLOR = '#2f6fed';

function renderText(c: Content): string {
    const parts = [`Xin chào ${c.displayName},`, ...c.intro];
    if (c.action) parts.push(c.action.url);
    parts.push(...c.outro);
    return parts.join('\n\n');
}

function renderHtml(subject: string, c: Content): string {
    const p = (text: string) =>
        `<p style="margin:0 0 16px;line-height:1.6;color:#1f2937">${escapeHtml(text)}</p>`;
    const button = c.action
        ? `<p style="margin:24px 0"><a href="${escapeHtml(c.action.url)}" style="background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;font-weight:600">${escapeHtml(c.action.label)}</a></p>
      <p style="margin:0 0 16px;line-height:1.5;color:#6b7280;font-size:13px">Nếu nút không bấm được, hãy dán liên kết này vào trình duyệt:<br><a href="${escapeHtml(c.action.url)}" style="color:${BRAND_COLOR};word-break:break-all">${escapeHtml(c.action.url)}</a></p>`
        : '';
    return `<!doctype html>
            <html lang="vi">
                <head>
                    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
                    <title>${escapeHtml(subject)}</title>
                </head>
                <body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
                    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
                        <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:${BRAND_COLOR}">Bookaria</p>
                        ${p(`Xin chào ${c.displayName},`)}
                        ${c.intro.map(p).join('\n    ')}
                        ${button}
                        ${c.outro.map(p).join('\n    ')}
                    </div>
                </body>
            </html>`;
}

function build(to: string, subject: string, content: Content): Mail {
    return { to, subject, text: renderText(content), html: renderHtml(subject, content) };
}

export function verifyEmailMail(to: string, displayName: string, token: string): Mail {
    return build(to, 'Xác nhận email tài khoản Bookaria', {
        displayName,
        intro: [
            `Bấm vào liên kết dưới đây để xác nhận email (có hiệu lực ${VERIFY_EMAIL_TTL_HOURS} giờ):`,
        ],
        action: {
            label: 'Xác nhận email',
            url: `${env.STUDIO_URL}/verify-email?token=${encodeURIComponent(token)}`,
        },
        outro: ['Nếu bạn không đăng ký Bookaria, hãy bỏ qua email này.'],
    });
}

export function resetPasswordMail(to: string, displayName: string, token: string): Mail {
    return build(to, 'Đặt lại mật khẩu Bookaria', {
        displayName,
        intro: [
            `Bấm vào liên kết dưới đây để đặt mật khẩu mới (có hiệu lực ${RESET_PASSWORD_TTL_MINUTES} phút, chỉ dùng một lần):`,
        ],
        action: {
            label: 'Đặt mật khẩu mới',
            url: `${env.STUDIO_URL}/reset-password?token=${encodeURIComponent(token)}`,
        },
        outro: ['Nếu bạn không yêu cầu, hãy bỏ qua email này; mật khẩu của bạn không thay đổi.'],
    });
}

/** Gửi sau khi đổi mật khẩu, để chủ tài khoản biết nếu người khác đã đổi. */
export function passwordChangedMail(to: string, displayName: string): Mail {
    return build(to, 'Mật khẩu Bookaria vừa được đổi', {
        displayName,
        intro: [
            'Mật khẩu tài khoản Bookaria của bạn vừa được đổi, và các thiết bị khác đã bị đăng xuất.',
        ],
        action: { label: 'Đặt lại mật khẩu', url: `${env.STUDIO_URL}/forgot-password` },
        outro: [
            'Nếu chính bạn đã đổi, không cần làm gì thêm. Nếu không phải bạn, hãy đặt lại mật khẩu ngay bằng liên kết trên.',
        ],
    });
}
