import type { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSmtpMailer, logMailer, setMailer, smtpTransport } from './mailer';

// Dựng một SMTP server thật trong tiến trình để kiểm tra thư được gửi đi đúng, không cần Docker.
const received: string[] = [];
let server: SMTPServer;
let url = '';

beforeAll(async () => {
    server = new SMTPServer({
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        onData(stream, _session, done) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
                received.push(Buffer.concat(chunks).toString());
                done();
            });
        },
    });
    const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.server.address() as AddressInfo).port));
    });
    url = `smtp://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
    received.length = 0;
    setMailer(undefined);
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('createSmtpMailer + smtpTransport', () => {
    it('gửi thư qua SMTP: đúng người gửi, người nhận, tiêu đề, bản text và html', async () => {
        const mailer = createSmtpMailer(smtpTransport(url), 'Bookaria <no-reply@bookaria.test>');
        await mailer.send({
            to: 'an@example.com',
            subject: 'Xác nhận email',
            text: 'Xin chào An',
            html: '<p>Xin chào <b>An</b></p>',
        });

        expect(received).toHaveLength(1);
        const mail = await simpleParser(received[0] as string);
        expect(mail.from?.text).toBe('"Bookaria" <no-reply@bookaria.test>');
        expect(mail.subject).toBe('Xác nhận email');
        expect(mail.text).toContain('Xin chào An');
        expect(mail.html).toContain('<b>An</b>');
    });

    it('server không hoạt động thì báo lỗi nhanh, không treo request', async () => {
        const dead = createSmtpMailer(smtpTransport('smtp://127.0.0.1:1'), 'x@example.com');
        const started = Date.now();
        await expect(dead.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});

describe('getMailer chọn bộ gửi theo SMTP_URL', () => {
    it('không có SMTP_URL thì dùng logMailer (chỉ ghi log)', async () => {
        vi.stubEnv('SMTP_URL', '');
        const { getMailer, logMailer: log } = await import('./mailer');
        expect(getMailer()).toBe(log);
        expect(logMailer).toBeDefined();
    });

    it('có SMTP_URL thì thật sự gửi qua SMTP (không rơi về logMailer)', async () => {
        vi.stubEnv('SMTP_URL', url);
        vi.stubEnv('MAIL_FROM', 'Bookaria <no-reply@bookaria.test>');
        const { getMailer, logMailer: log } = await import('./mailer');

        const mailer = getMailer();
        expect(mailer).not.toBe(log);
        await mailer.send({ to: 'an@example.com', subject: 'Chào', text: 'nội dung' });

        expect(received).toHaveLength(1);
        const mail = await simpleParser(received[0] as string);
        expect(mail.subject).toBe('Chào');
    });

    it('setMailer thay được bộ gửi, và setMailer(undefined) quay về mặc định', async () => {
        vi.stubEnv('SMTP_URL', '');
        const { getMailer, setMailer: set, logMailer: log } = await import('./mailer');
        const sent: string[] = [];
        set({
            async send(mail) {
                sent.push(mail.to);
            },
        });
        await getMailer().send({ to: 'x@example.com', subject: 's', text: 't' });
        expect(sent).toEqual(['x@example.com']);

        set(undefined);
        expect(getMailer()).toBe(log);
    });
});
