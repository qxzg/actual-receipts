#!/usr/bin/env python3
"""Assemble Docker load archives locally without a Docker daemon.
Uses verified official image layers and locally installed production dependencies.
"""
import copy, gzip, hashlib, io, json, os, pathlib, shutil, tarfile, urllib.request, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'images'
CACHE = pathlib.Path('/tmp/receipts-image-cache')
OUT.mkdir(parents=True, exist_ok=True); CACHE.mkdir(parents=True, exist_ok=True)
TAG = '24.20.0-bookworm-slim'
REPO = 'library/node'
def fetch(url, headers={}):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90)
token = json.load(fetch('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull'))['token']
headers = {'Authorization':'Bearer '+token, 'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}
def manifest(ref):
    with fetch(f'https://registry-1.docker.io/v2/{REPO}/manifests/{ref}',headers) as r:
        raw=r.read()
        if ref.startswith('sha256:'): assert hashlib.sha256(raw).hexdigest()==ref.split(':')[1]
        return json.loads(raw), 'sha256:'+hashlib.sha256(raw).hexdigest()
index,_=manifest(TAG)
ref=next(m['digest'] for m in index['manifests'] if m['platform']['os']=='linux' and m['platform']['architecture']=='amd64')
image_manifest,base_digest=manifest(ref)
def blob(digest):
    target=CACHE/digest.replace(':','-')
    if not target.exists():
        with fetch(f'https://registry-1.docker.io/v2/{REPO}/blobs/{digest}',headers) as src, open(str(target)+'.partial','wb') as dst: shutil.copyfileobj(src,dst)
        os.rename(str(target)+'.partial',target)
    assert hashlib.file_digest(open(target,'rb'),'sha256').hexdigest()==digest.split(':')[1]
    return target
config=json.loads(blob(image_manifest['config']['digest']).read_bytes())
base_layers=[]
for descriptor,diff in zip(image_manifest['layers'],config['rootfs']['diff_ids']):
    archive=blob(descriptor['digest']); layer=CACHE/(diff.replace(':','-')+'.tar')
    if not layer.exists():
        with gzip.open(archive,'rb') as src,open(layer,'wb') as dst: shutil.copyfileobj(src,dst)
    assert hashlib.file_digest(open(layer,'rb'),'sha256').hexdigest()==diff.split(':')[1]
    base_layers.append(layer)
def metadata(t):
    t.uid=t.gid=1000;t.uname=t.gname='node';t.mtime=0
    return t
app_layer=CACHE/'receipt-app-layer.tar'
with tarfile.open(app_layer,'w',format=tarfile.PAX_FORMAT) as tf:
    for source,target in [(ROOT/'dist','app/dist'),(ROOT/'package.json','app/package.json'),(pathlib.Path('/tmp/receipts-release/node_modules'),'app/node_modules')]: tf.add(source,arcname=target,filter=metadata)
    for name in ('data','app/data'):
        t=tarfile.TarInfo(name);t.type=tarfile.DIRTYPE;t.mode=0o700;tf.addfile(metadata(t))
provider_layer=CACHE/'receipt-provider-layer.tar'
with tarfile.open(provider_layer,'w',format=tarfile.PAX_FORMAT) as tf:
    tf.add('/tmp/receipts-provider-release/node_modules',arcname='app/codex/node_modules',filter=metadata)
    t=tarfile.TarInfo('data/codex');t.type=tarfile.DIRTYPE;t.mode=0o700;tf.addfile(metadata(t))
results=json.loads((OUT/'manifest.json').read_text()) if '--app-only' in sys.argv else {}
for name,layers,command in [('receipt-app',base_layers+[app_layer],['node','dist/server/main.js']),('codex-provider',base_layers+[app_layer,provider_layer],['node','dist/provider/main.js'])]:
    if '--app-only' in sys.argv and name=='codex-provider': continue
    c=copy.deepcopy(config);c['rootfs']['diff_ids']=['sha256:'+hashlib.file_digest(open(p,'rb'),'sha256').hexdigest() for p in layers]
    c['config'].update({'WorkingDir':'/app','User':'1000:1000','Cmd':command,'Entrypoint':None,'Env':config['config'].get('Env',[])+['NODE_ENV=production','HOST=0.0.0.0','DATA_DIR=/data','CODEX_HOME=/data/codex','CODEX_BIN=/app/codex/node_modules/.bin/codex']})
    c['history']=c.get('history',[])+[{'created':'2026-09-07T00:00:00Z','created_by':'receipt-ledger local release assembly'} for _ in layers[len(base_layers):]]
    raw=json.dumps(c,separators=(',',':')).encode(); digest=hashlib.sha256(raw).hexdigest();config_name=digest+'.json'
    names=[str(i)+'/layer.tar' for i in range(len(layers))]
    output=OUT/(name+'-0.1.0.tar.gz')
    with tarfile.open(output,'w:gz',compresslevel=3) as tf:
        for p,n in zip(layers,names): tf.add(p,arcname=n)
        for n,b in [(config_name,raw),('manifest.json',json.dumps([{'Config':config_name,'RepoTags':[name+':0.1.0'],'Layers':names}]).encode())]: t=tarfile.TarInfo(n);t.size=len(b);tf.addfile(t,io.BytesIO(b))
    results[name]={'image_id':'sha256:'+digest,'archive_sha256':hashlib.file_digest(open(output,'rb'),'sha256').hexdigest(),'bytes':output.stat().st_size}
    print(name,results[name],flush=True)
results['base']={'tag':'node:'+TAG,'manifest_digest':base_digest}
(OUT/'manifest.json').write_text(json.dumps(results,indent=2)+'\n')
(ROOT/'deploy'/'base-image.env').write_text('NODE_IMAGE=node@'+base_digest+'\n')
