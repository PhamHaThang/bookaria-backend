import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = fileURLToPath(
    new URL(
        process.platform === 'win32' ? './.venv/Scripts/python.exe' : './.venv/bin/python',
        import.meta.url,
    ),
);
const child = spawn(
    python,
    ['-X', 'utf8', fileURLToPath(new URL('./server.py', import.meta.url))],
    {
        stdio: 'inherit',
        windowsHide: true,
    },
);
child.on('error', (error) => {
    console.error(
        'Create services/zerotts/.venv and install requirements.txt first.',
        error.message,
    );
    process.exitCode = 1;
});
child.on('exit', (code) => {
    process.exitCode = code ?? 1;
});
process.once('SIGINT', () => child.kill());
process.once('SIGTERM', () => child.kill());
