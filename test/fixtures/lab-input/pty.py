"""Real canonical PTY: stdin, stdout and stderr share one terminal. No workers."""
import errno
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

root = Path(__file__).resolve().parents[3]
command = [sys.argv[1], '--import', 'tsx', '--import',
           str(root / 'test/fixtures/lab-input/stub-loader.mjs'),
           str(root / 'dev/cli/lab.ts'), 'run']
report = {}


def drain(fd, seconds):
    output = b''
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output += chunk
    return output


def send(fd, data):
    while data:
        data = data[os.write(fd, data):]


with tempfile.TemporaryDirectory(prefix='lab-input-pty-') as directory:
    capture = Path(directory) / 'received.txt'
    env = {**os.environ, 'AGENTLAB_INPUT_CAPTURE': str(capture)}
    for scenario in ['eof', 'unterminated', 'interrupt']:
        before_capture = capture.stat().st_mtime_ns if capture.exists() else None
        master, slave = os.openpty()
        initial = termios.tcgetattr(slave)

        def own_terminal():
            os.setsid()
            import fcntl
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        child = subprocess.Popen(command, cwd=root, env=env, stdin=slave,
                                 stdout=slave, stderr=slave, preexec_fn=own_terminal)
        transcript = b''
        try:
            deadline = time.monotonic() + 15
            while b'\n> ' not in transcript and time.monotonic() < deadline:
                transcript += drain(master, .1)
            assert b'\n> ' in transcript, transcript
            if scenario == 'unterminated':
                send(master, 'última linha'.encode())
                drain(master, .1)
                # In canonical mode the first EOF flushes a pending line; the
                # second ends the stream. Preserve this standard terminal rule.
                send(master, b'\x04')
                drain(master, .1)
                send(master, b'\x04')
                after = drain(master, 1.5)
                child.wait(timeout=10)
                assert capture.read_bytes() == 'última linha'.encode()
                report['unterminated'] = {'byte_equal': True,
                                          'fresh_line': after.startswith(b'\r\n')}
                continue
            during = b''
            # Slow typing crosses three real one-second refresh intervals.
            for part in [b'---agent', b'lab', b'\nversion: 1\n']:
                send(master, part)
                during += drain(master, 1.1)
            if scenario == 'interrupt':
                send(master, b'\x03')
                after = drain(master, 1.3)
                code = child.wait(timeout=5)
                assert code in [-signal.SIGINT, 130], (code, after)
                assert termios.tcgetattr(slave) == initial, 'terminal mode changed'
                assert b'PREFLIGHT' not in after
                assert capture.stat().st_mtime_ns == before_capture
                report['interrupt'] = {'exit': code, 'terminal_restored': True}
                continue

            # DEL (Backspace), Ctrl+U and accents use the terminal line discipline.
            send(master, 'desc: erroX'.encode())
            during += drain(master, .1)
            send(master, b'\x7f\nwrong line\x15')
            body = ('desc: ação, químico; $HOME `x` \\ & <> [] {} !\n\n'
                    'target:\n  type: repository\n  path: /fixture/never-executed\n---\n')
            body += ('## Objetivo — não executar\n\nTexto longo com acentos: ç ã é.\n' * 240)
            # One multiline paste, larger than a screen and than the input queue.
            send(master, body.encode())
            during += drain(master, 1.2)
            send(master, b'\x04')
            after = drain(master, 1.5)
            child.wait(timeout=10)
            after += drain(master, .1)
            expected = ('---agentlab\nversion: 1\ndesc: erro\n' + body).encode()
            actual = capture.read_bytes()
            assert actual == expected, (len(actual), len(expected))
            assert child.returncode == 0, after
            assert after.count(b'PREFLIGHT') >= 2, after
            assert termios.tcgetattr(slave) == initial, 'terminal mode changed'
            report['eof'] = {'received_bytes': len(actual), 'byte_equal': True,
                             'redraws_during_input': during.count(b'\x1b['),
                             'progress_during_input': during.count(b'WAITING_FOR_INPUT'),
                             'progress_after_eof': after.count(b'PREFLIGHT'),
                             'first_frame_appended': b'\x1b[' not in after.split(b'PREFLIGHT')[0]}
            transcript += during + after
            if os.environ.get('AGENTLAB_PTY_TRANSCRIPT'):
                Path(os.environ['AGENTLAB_PTY_TRANSCRIPT']).write_bytes(transcript)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            os.close(master)
            os.close(slave)

    # Pipes and --prompt-file still use the actual CLI, with the same safe boundary.
    raw = '---agentlab\nversion: 1\n---\n\ná ç $ <>\n'.encode()
    for mode in ['pipe', 'file']:
        prompt = Path(directory) / 'directive.txt'
        prompt.write_bytes(raw)
        args = command + (['--prompt-file', str(prompt)] if mode == 'file' else [])
        result = subprocess.run(args, cwd=root, env=env, input=raw if mode == 'pipe' else b'',
                                capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert capture.read_bytes() == raw
        assert b'Paste the complete' not in result.stderr
        assert json.loads(result.stdout)['input_fixture'] is True
        report[mode] = 'byte_equal'
print(json.dumps(report))
