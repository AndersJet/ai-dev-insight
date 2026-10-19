"""Package the isolated host probe using Python's standard library only."""
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent.parent / '.run' / 'wayfinder-host-probe'

def archive(files):
    output = BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=6) as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    return output.getvalue()

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'package.json').read_text())
    version = manifest['version']
    xml = f'''<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="{manifest['name']}" Version="{version}" Publisher="{manifest['publisher']}"/><DisplayName>ADI Host Capability Probe (synthetic only)</DisplayName><Description>Owned synthetic host validation; no product data</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{manifest['engines']['vscode']}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>'''
    files = {'extension.vsixmanifest': xml.encode(), '[Content_Types].xml': b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'}
    for name in ('package.json', 'extension.cjs', 'mock-server.cjs', 'transport.cjs', 'probe.svg', 'README.md'):
        files['extension/' + name] = (ROOT / name).read_bytes()
    vsix = archive(files)
    vsix_name = f'adi-host-capability-probe-{version}.vsix'
    (OUT / vsix_name).write_bytes(vsix)
    delivery = {vsix_name: vsix, 'README.md': (ROOT / 'README.md').read_bytes(), 'windows-preflight.ps1': (ROOT / 'windows-preflight.ps1').read_bytes()}
    fixture = json.dumps({'synthetic': True, 'probe_id': 'adi-test.adi-host-capability-probe'}, indent=2).encode()
    for window in ('window-a', 'window-b'):
        prefix = window + '/adi-host-probe-workspace/'
        delivery[prefix + '.adi-probe-fixture.json'] = fixture
        delivery[prefix + 'README.txt'] = b'Synthetic empty workspace for ADI host probe. No business files.'
    info = {'probe_version': version, 'extension_id': 'adi-test.adi-host-capability-probe', 'vsix_sha256': hashlib.sha256(vsix).hexdigest(), 'engine': manifest['engines']['vscode'], 'synthetic_only': True, 'host_tests_performed': False}
    delivery['delivery.json'] = json.dumps(info, indent=2).encode()
    bundle = OUT / f'adi-host-probe-manual-{version}.zip'
    bundle.write_bytes(archive(delivery))
    (OUT / 'delivery.json').write_text(json.dumps(info, indent=2))
    print(json.dumps({'bundle': str(bundle), 'vsix': str(OUT / vsix_name), **info}))
