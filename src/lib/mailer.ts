import nodemailer from 'nodemailer';
import { env, logger } from '../config';

export interface Mail {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

/** Bất kỳ thứ gì gửi được email. */
export interface Mailer {
    send(mail: Mail): Promise<void>;
}

/** Phần tối thiểu của một transport kiểu nodemailer (để test thay được bằng bản giả). */
export interface Transport {
    sendMail(message: {
        from: string;
        to: string;
        subject: string;
        text: string;
        html?: string;
    }): Promise<unknown>;
}

/**
 * Khi không có SMTP_URL: ghi mail vào log thay vì gửi. Nội dung thư chứa link kèm token nên chỉ ghi đầy đủ ở dev; production chỉ ghi người nhận và tiêu đề.
 */
export const logMailer: Mailer = {
    async send(mail) {
        logger.info(
            {
                to: mail.to,
                subject: mail.subject,
                ...(env.NODE_ENV !== 'production' && { text: mail.text }),
            },
            'email (not sent: log mailer)',
        );
    },
};

/** Gửi qua một transport kiểu nodemailer. */
export function createSmtpMailer(transport: Transport, from: string): Mailer {
    return {
        async send(mail) {
            await transport.sendMail({
                from,
                to: mail.to,
                subject: mail.subject,
                text: mail.text,
                ...(mail.html === undefined ? {} : { html: mail.html }),
            });
        },
    };
}

/**
 * Kết nối tới SMTP server theo URL. Các timeout rất quan trọng: đăng ký phải chờ thư được bàn giao,
 * nên mail server chết phải báo lỗi trong vài giây chứ không treo request hàng phút.
 */
export function smtpTransport(url: string): Transport {
    return nodemailer.createTransport({
        url,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
    });
}

/** Chưa chọn: tạo lười ở lần gọi đầu, theo `SMTP_URL` (có thì gửi SMTP, không thì ghi log). */
let current: Mailer | undefined;

export const getMailer = (): Mailer => {
    current ??= env.SMTP_URL
        ? createSmtpMailer(smtpTransport(env.SMTP_URL), env.MAIL_FROM)
        : logMailer;
    return current;
};

/** Thay bộ gửi (dùng trong test, hoặc truyền `undefined` để quay về mặc định theo `SMTP_URL`). */
export const setMailer = (mailer: Mailer | undefined): void => {
    current = mailer;
};

/** Gửi thư nhưng không để lỗi gửi làm hỏng request: chỉ ghi log. */
export async function sendMailSafely(mail: Mail): Promise<void> {
    try {
        await getMailer().send(mail);
    } catch (err) {
        logger.error({ err, to: mail.to }, 'sending email failed');
    }
}
