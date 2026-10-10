import { env, logger } from '../config';

export interface Mail {
    to: string;
    subject: string;
    text: string;
}

/** Anything that can send an email. */
export interface Mailer {
    send(mail: Mail): Promise<void>;
}

/** Development default: writes the email to the log instead of sending it. */
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

let current: Mailer = logMailer;
export const getMailer = () => current;
export const setMailer = (mailer: Mailer) => {
    current = mailer;
};
