#!/usr/bin/env python3
"""Root-owned, forced-command resolver endpoint. No user-controlled commands or paths."""
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

from records_apply import replace_rewrites, existing_mappings
from render_adguard_config import rendered_domains, render_rewrites
from dns_probe import query_udp, query_tcp
from move_records import allowed_removed

ROOT = Path('/srv/dns-platform')


def run(args, timeout=120):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed during DNS operation')
    return result.stdout.strip()


def checked_records(value):
    if not isinstance(value, dict) or value.get('zone') != 'bulock' or not isinstance(value.get('records'), list) or not value['records']:
        raise ValueError('Expected nonempty bulock records')
    addresses = set()
    for record in value['records']:
        ipaddress.IPv4Address(record['value'])
        if record.get('type') != 'A' or record['value'] in addresses or not isinstance(record.get('names'), list) or not record['names']:
            raise ValueError('Invalid address record')
        addresses.add(record['value'])
        for name in record['names']:
            if not isinstance(name, str) or len(name) > 253 or not all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part) for part in name.split('.')):
                raise ValueError('Invalid record name')
    return value


def handle(request):
    operation = request.get('operation')
    if operation == 'health':
        return {'state': run(['docker','inspect','--format','{{.State.Health.Status}}','adguardhome']), 'capabilities': ['hostname.move']}
    if operation == 'probe':
        records = checked_records(request['records'])
        ip = str(ipaddress.IPv4Address(request['ip']))
        target = next(r for r in records['records'] if r['value'] == ip)
        # Probe in the resolver network namespace: macvlan hosts cannot reach their own container directly.
        pid = run(['docker','inspect','--format','{{.State.Pid}}','adguardhome'])
        if not pid.isdigit() or int(pid) <= 1:
            raise ValueError('Resolver is not running')
        for name in target['names']:
            for domain in rendered_domains(name, records['zone']):
                for protocol in ['udp','tcp']:
                    run(['nsenter','-t',pid,'-n',sys.executable,str(Path(__file__).with_name('dns_probe.py')),
                         '--server','127.0.0.1','--name',domain,'--expected',ip,'--protocol',protocol])
        return {'state':'live'}
    id = str(uuid.UUID(request.get('id','')))
    backup = ROOT / 'backups' / id
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    if operation == 'backup':
        archive = backup / 'predeploy.tgz'
        if not archive.exists():
            run(['tar','-czf',str(backup/'predeploy.tmp'),'-C',str(ROOT),'conf','work','config'], timeout=600)
            os.replace(backup/'predeploy.tmp', archive)
            os.chmod(archive,0o600)
        return {'backup':str(archive)}
    if operation != 'deploy':
        raise ValueError('Unsupported resolver operation')
    if not (backup/'predeploy.tgz').exists():
        raise ValueError('A completed backup is required')
    desired = checked_records(request['records'])
    current_records = json.loads((ROOT/'config/local-records.json').read_text())
    mappings = lambda records: {(r['value'],name.lower()) for r in records['records'] for name in r['names']}
    removed, removed_rewrites = allowed_removed(current_records, desired, request.get('move'))
    if not mappings(current_records) - removed <= mappings(desired):
        raise ValueError('Candidate would remove existing resolver names; reconcile live records first')
    config = ROOT/'conf/AdGuardHome.yaml'
    original = config.read_bytes()
    expected = {(r['domain'],r['answer']) for r in render_rewrites(desired)}
    if not existing_mappings(original.decode()) - removed_rewrites <= expected:
        raise ValueError('Candidate would remove active DNS answers; reconcile live resolver rewrites first')
    staged = ROOT/'conf/controller-next.yaml'
    staged.write_text(replace_rewrites(original.decode(), desired)); os.chmod(staged,0o600)
    run(['docker','exec','adguardhome','/opt/adguardhome/AdGuardHome','--config','/opt/adguardhome/conf/controller-next.yaml','--check-config'])
    # Validation may canonicalize the staged file. Use the exact validated bytes.
    candidate = staged.read_bytes()
    run(['docker','stop','adguardhome'])
    installed = False
    try:
        if config.read_bytes() != original:
            raise ValueError('Resolver configuration changed during deployment; retry after reconciliation')
        os.replace(staged,config); installed=True
        run(['docker','start','adguardhome'])
        import time
        for _ in range(30):
            if run(['docker','inspect','--format','{{.State.Health.Status}}','adguardhome']) == 'healthy':
                pending = ROOT/'config/controller-next.json'
                pending.write_text(json.dumps(desired,indent=2)+'\n')
                os.replace(pending,ROOT/'config/local-records.json')
                return {'state':'healthy'}
            time.sleep(2)
        raise RuntimeError('Resolver did not become healthy')
    except Exception:
        if installed:
            run(['docker','stop','adguardhome'])
            # Restore the configuration observed at the start of this attempt.
            config.write_bytes(original); os.chmod(config,0o600)
        run(['docker','start','adguardhome'])
        raise


def main():
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(4*1024*1024+1)
        if len(raw)>4*1024*1024:
            raise ValueError('Request too large')
        with (ROOT/'controller.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            result=handle(json.loads(raw))
    except Exception as error:
        result={'error':str(error)}
    print(json.dumps(result))


if __name__=='__main__': main()
