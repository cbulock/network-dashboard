#!/usr/bin/env python3
"""Restricted JSON-over-SSH control endpoint and durable, serial DNS worker."""
import argparse
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import uuid

from render_adguard_config import rendered_domains, render_rewrites
from dns_probe import query_udp, query_tcp
from move_records import move_records, append_move


def hostname(value):
    name = str(value).strip().lower().rstrip('.')
    if not name or len(name) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in name.split('.')):
        raise ValueError('Invalid DNS hostname')
    return name


def revise_records(document, name, address):
    name = hostname(name)
    ip = ipaddress.IPv4Address(address)
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or int(ip) >= int(ipaddress.IPv4Address('240.0.0.0')):
        raise ValueError('Select a device IPv4 address')
    result = json.loads(json.dumps(document))
    domains = set(rendered_domains(name, result['zone']))
    target = next((record for record in result['records'] if record['value'] == str(ip)), None)
    # Existing multi-answer names may be promoted at an address where they already exist.
    existing_domains = {domain for n in (target or {}).get('names', []) for domain in rendered_domains(n, result['zone'])}
    for record in result['records']:
        if record['value'] == str(ip):
            continue
        other = {domain.lower() for n in record['names'] for domain in rendered_domains(n, result['zone'])}
        if domains & other and not domains <= existing_domains:
            raise ValueError('That hostname already points to another address')
    if target is None:
        target = {'type': 'A', 'value': str(ip), 'names': []}
        result['records'].append(target)
    target['names'] = [name] + [n for n in target['names'] if n.lower() != name]
    render_rewrites(result)
    return result


class Controller:
    def __init__(self, config):
        self.config = config
        self.repo = Path(config['repo'])
        self.state = Path(config['state'])
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.state / 'jobs.sqlite', timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL,
            result TEXT NOT NULL, created REAL NOT NULL)''')
        self.db.commit()

    @contextlib.contextmanager
    def lock(self):
        with (self.state / 'controller.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    def run(self, args, timeout=600, cwd=None):
        result = subprocess.run(args, cwd=cwd or self.repo, capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'ANSIBLE_CONFIG': str(self.repo / 'ansible/ansible.cfg')})
        if result.returncode:
            # Ansible can include credentials in failed task output: retain locally, never return it to the UI.
            log = self.state / 'last-command.log'
            log.touch(mode=0o600, exist_ok=True)
            log.write_text(result.stdout + result.stderr)
            raise RuntimeError(f'{Path(args[0]).name} failed; inspect controller logs on Tools')
        return result.stdout.strip()

    def records(self, published=False):
        path = self.repo / 'config/local-records.json'
        ref = f"origin/{self.config.get('branch','main')}" if published else 'HEAD'
        document = json.loads(self.run(['git','show',f'{ref}:config/local-records.json'])) if published else json.loads(path.read_bytes())
        canonical = json.dumps(document,sort_keys=True,separators=(',',':')).encode()
        return {**document, 'revision': hashlib.sha256(canonical).hexdigest(),
                'commit': self.run(['git', 'rev-parse', ref])}

    def refresh(self):
        branch = self.config.get('branch', 'main')
        if self.run(['git', 'status', '--porcelain', '--untracked-files=no']):
            raise RuntimeError('Controller checkout has uncommitted changes; reconcile it before updating DNS')
        self.run(['git', 'fetch', 'origin', branch])
        # Never overwrite or rebase a recorded controller commit.
        self.run(['git', 'merge', '--ff-only', f'origin/{branch}'])

    def result(self, id):
        row = self.db.execute('SELECT * FROM jobs WHERE id=?', [id]).fetchone()
        return json.loads(row['result']) if row else None

    def save(self, id, result):
        self.db.execute('UPDATE jobs SET state=?,result=? WHERE id=?', [result['state'], json.dumps(result), id])
        self.db.commit()

    def node_request(self, node, request):
        result = subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                                 '-o','ConnectTimeout=10',node['ssh'],'dns-platform-node'],
                                input=json.dumps(request),capture_output=True,text=True,timeout=900)
        if result.returncode:
            raise RuntimeError(f"Resolver SSH request failed on {node['name']}")
        response=json.loads(result.stdout)
        if response.get('error'):
            raise RuntimeError(f"{node['name']}: {response['error']}")
        return response

    def request(self, request):
        operation = request.get('operation')
        with contextlib.nullcontext():
            if operation == 'records.list':
                unresolved = self.db.execute("SELECT 1 FROM jobs WHERE state IN ('pending','deploying') OR (state='failed' AND json_extract(result,'$.commit') IS NOT NULL)").fetchone()
                if not unresolved:
                    with self.lock():
                        self.refresh()
                return {**self.records(published=True), 'capabilities': self.move_capabilities()}
            id = str(uuid.UUID(request.get('id', '')))
            existing = self.result(id)
            if operation == 'job.get':
                if not existing:
                    raise ValueError('Unknown DNS request')
                return existing
            if operation == 'job.retry':
                if not existing:
                    raise ValueError('Unknown DNS request')
                if existing['state'] != 'failed':
                    return existing
                if existing.get('conflict'):
                    raise ValueError('Refresh the device and save a new request to resolve this conflict')
                existing.update(state='pending', error=None)
                self.save(id, existing)
                return existing
            if operation not in ('hostname.set', 'hostname.move'):
                raise ValueError('Unsupported operation')
            desired = {k: request.get(k) for k in ('hostname', 'ip', 'expectedRevision')}
            if operation == 'hostname.move':
                desired['fromIp'] = str(ipaddress.IPv4Address(request['fromIp']))
            if existing:
                original = json.loads(self.db.execute('SELECT request FROM jobs WHERE id=?', [id]).fetchone()[0])
                if original != desired:
                    raise ValueError('Request ID was already used with different content')
                return existing
            desired['hostname'] = hostname(desired['hostname'])
            ipaddress.IPv4Address(desired['ip'])
            if not re.fullmatch('[0-9a-f]{64}', desired['expectedRevision'] or ''):
                raise ValueError('A records revision is required')
            result = {'id': id, 'state': 'pending', 'hostname': desired['hostname'], 'ip': desired['ip'], 'nodes': {}}
            self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?)', [id,json.dumps(desired),'pending',json.dumps(result),time.time()])
            self.db.commit()
            return result

    def move_capabilities(self):
        try:
            return ['hostname.move'] if all('hostname.move' in self.node_request(node, {'operation': 'health'}).get('capabilities', []) for node in self.config['resolvers']) else []
        except Exception:
            return []

    def deploy(self, id):
        job = self.result(id)
        request = json.loads(self.db.execute('SELECT request FROM jobs WHERE id=?', [id]).fetchone()[0])
        job.update(state='deploying', error=None)
        self.save(id, job)
        try:
            if not job.get('commit'):
                # Recover a commit created just before a process interruption.
                message = self.run(['git', 'log', '-1', '--format=%B'])
                if f'DNS-Request: {id}' in message:
                    job['commit'] = self.run(['git', 'rev-parse', 'HEAD'])
                else:
                    self.refresh()
                    records = self.records()
                    if records['revision'] != request['expectedRevision']:
                        job['conflict'] = True
                        raise ValueError('DNS records changed. Refresh the device before saving again.')
                    try:
                        revised = (move_records({'zone': records['zone'], 'records': records['records']}, request['hostname'], request['fromIp'], request['ip'])
                                   if request.get('fromIp') else revise_records({'zone': records['zone'], 'records': records['records']}, request['hostname'], request['ip']))
                    except ValueError:
                        job['conflict'] = True
                        raise
                    candidate = self.state / f'{id}.json'
                    candidate.write_text(json.dumps(revised, indent=2) + '\n')
                    moves_path = self.repo / 'config/address-moves.json'
                    staged_moves = None
                    if request.get('fromIp'):
                        ledger = json.loads(moves_path.read_text()) if moves_path.exists() else {'moves': []}
                        ledger = append_move(ledger, {**request, 'id': id}, records)
                        staged_moves = self.state / f'{id}-moves.json'
                        staged_moves.write_text(json.dumps(ledger, indent=2) + '\n')
                    self.run([sys.executable, 'scripts/validate_legacy_records.py', '--hosts-file', 'config/legacy-dnsmasq.hosts',
                              '--records-file', str(candidate), '--zone', records['zone']] +
                             (['--moves-file', str(staged_moves)] if staged_moves else []))
                    self.run([sys.executable, 'scripts/validate_render_rewrites.py'])
                    records_path = self.repo / 'config/local-records.json'
                    if candidate.read_bytes() != records_path.read_bytes():
                        temporary = records_path.with_suffix('.tmp')
                        temporary.write_bytes(candidate.read_bytes())
                        os.replace(temporary, records_path)
                        if staged_moves:
                            os.replace(staged_moves, moves_path)
                        self.run(['git', 'add', '--', 'config/local-records.json'] + (['config/address-moves.json'] if staged_moves else []))
                        self.run(['git', '-c', 'user.name=DNS Platform', '-c', 'user.email=dns-platform@localhost',
                                  'commit', '-m', f"Set {request['hostname']} on {request['ip']}\n\nDNS-Request: {id}"])
                    job['commit'] = self.run(['git', 'rev-parse', 'HEAD'])
                self.save(id, job)
            if self.run(['git', 'rev-parse', 'HEAD']) != job['commit']:
                raise RuntimeError('Controller revision changed; reconcile before retrying this deployment')
            branch = self.config.get('branch', 'main')
            self.run(['git', 'push', 'origin', f"{job['commit']}:refs/heads/{branch}"])
            job['published'] = True
            self.save(id, job)
            backup = Path('/srv/dns-platform/backups') / id
            if not job.get('backup'):
                for node in self.config['resolvers']:
                    self.node_request(node, {'operation':'backup','id':id})
                job['backup'] = str(backup)
                self.save(id, job)
            records = self.records()
            target = next(r for r in records['records'] if r['value'] == request['ip'])
            for node in self.config['resolvers']:
                server = node['address']
                job['nodes'][server] = 'deploying'
                self.save(id, job)
                self.node_request(node, {'operation':'deploy','id':id,'records':{'zone':records['zone'],'records':records['records']},
                                         **({'move': request} if request.get('fromIp') else {})})
                job['nodes'][server] = 'verifying'
                self.save(id, job)
                self.node_request(node, {'operation':'probe','ip':request['ip'],'records':{'zone':records['zone'],'records':records['records']}})
                job['nodes'][server] = 'live'
                self.save(id, job)
            job.update(state='live', revision=records['revision'])
        except Exception as error:
            job.update(state='failed', error=str(error))
        self.save(id, job)

    def work(self, once=False):
        # systemd KillMode=control-group terminates descendants before a restart.
        with self.lock():
            for row in self.db.execute("SELECT id,result FROM jobs WHERE state='deploying'").fetchall():
                result = json.loads(row['result'])
                result.update(state='failed', error='Controller interrupted. Inspect resolver state, then retry.')
                self.save(row['id'], result)
        while True:
            with self.lock():
                blocker = self.db.execute("SELECT 1 FROM jobs WHERE state='failed' AND json_extract(result,'$.commit') IS NOT NULL").fetchone()
                row = self.db.execute("SELECT id FROM jobs WHERE state='pending' ORDER BY created LIMIT 1").fetchone()
                if row and not blocker:
                    self.deploy(row['id'])
            if once:
                return
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/dns-platform/controller.json')
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    controller = Controller(json.loads(Path(args.config).read_text()))
    if args.worker:
        controller.work(args.once)
    else:
        try:
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                raise ValueError('Request too large')
            result = controller.request(json.loads(raw))
        except Exception as error:
            result = {'error': str(error)}
        print(json.dumps(result))


if __name__ == '__main__':
    main()
