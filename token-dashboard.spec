# PyInstaller spec — single-file executable for Token Dashboard.
# Build: pyinstaller token-dashboard.spec
from PyInstaller.utils.hooks import collect_data_files

datas = [
    ('token_dashboard/web', 'token_dashboard/web'),
    ('token_dashboard/pricing.json', 'token_dashboard'),
]

a = Analysis(
    ['cli.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[
        'token_dashboard',
        'token_dashboard.scanner',
        'token_dashboard.skills',
        'token_dashboard.tips',
        'token_dashboard.pricing',
        'token_dashboard.reloader',
        'token_dashboard.db',
        'token_dashboard.db.queries',
        'token_dashboard.db.projects',
        'token_dashboard.db.schema',
        'token_dashboard.server',
        'token_dashboard.server.routes',
        'token_dashboard.server.scan_loop',
        'token_dashboard.server.sse',
        'token_dashboard.server.http_utils',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='token-dashboard',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
