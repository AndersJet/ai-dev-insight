"""Compile the developer-only native Git fixture with a local Zig toolchain.

No downloads or installation. The generated executable stays at the caller's
explicit output path; it must never be included in employee release archives.
"""
import argparse
import hashlib
import os
import pathlib
import subprocess
import tempfile

FUNCTIONS = ('GetCommandLineW', 'GetModuleFileNameW', 'CreateFileW', 'WriteFile',
             'CloseHandle', 'CreateProcessW', 'GetStdHandle', 'Sleep', 'ExitProcess', 'GetCurrentProcessId')


def build(zig, architecture, output):
    source = pathlib.Path(__file__).with_name('native-windows-git-fixture.c')
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='adi-native-fixture-') as directory:
        root = pathlib.Path(directory)
        env = dict(os.environ, ZIG_GLOBAL_CACHE_DIR=str(root/'cache'),
                   ZIG_LOCAL_CACHE_DIR=str(root/'local-cache'))
        definition, library = root/'kernel32.def', root/'kernel32.lib'
        definition.write_text('LIBRARY kernel32.dll\nEXPORTS\n'+'\n'.join(FUNCTIONS)+'\n')
        machine = 'arm64' if architecture == 'aarch64' else 'i386:x86-64'
        subprocess.run([str(zig), 'dlltool', '-m', machine, '-d', str(definition),
                        '-l', str(library)], check=True, env=env)
        subprocess.run([str(zig), 'cc', '-target', architecture+'-windows-msvc',
                        '-O2', '-fno-builtin', '-fno-stack-protector', '-nostdlib',
                        str(source), str(library), '-Wl,--entry,fixture_entry',
                        '-Wl,--subsystem,console', '-o', str(output)], check=True, env=env)
    print(f'{architecture}: {output.stat().st_size} bytes; sha256={hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--zig', required=True, type=pathlib.Path)
    parser.add_argument('--architecture', choices=['aarch64', 'x86_64'], default='aarch64')
    parser.add_argument('output', type=pathlib.Path)
    options = parser.parse_args()
    build(options.zig.resolve(), options.architecture, options.output)
