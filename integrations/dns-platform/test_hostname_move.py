"""Run in the DNS Platform repository after applying hostname-move.patch."""
import copy
import unittest
import uuid
import tempfile
import subprocess
import sys
import json
import shutil
from unittest.mock import patch
from pathlib import Path
from move_records import move_records, allowed_removed, append_move, legacy_address
from controller import Controller


class HostnameMoveTests(unittest.TestCase):
    def setUp(self):
        self.records = {'zone': 'bulock', 'records': [
            {'type': 'A', 'value': '10.0.0.10', 'names': ['server', 'files']},
            {'type': 'A', 'value': '10.0.0.20', 'names': ['other']}]}
        self.request = {'hostname': 'server', 'fromIp': '10.0.0.10', 'ip': '10.0.0.30'}

    def test_moves_all_aliases_without_changing_unrelated_names(self):
        previous = copy.deepcopy(self.records)
        result = move_records(self.records, 'server', '10.0.0.10', '10.0.0.30')
        self.assertEqual(self.records, previous)
        self.assertEqual(result['records'][0], previous['records'][1])
        self.assertEqual(result['records'][1]['names'], ['server', 'files'])
        removed, rewrites = allowed_removed(self.records, result, self.request)
        self.assertEqual(removed, {('10.0.0.10', 'server'), ('10.0.0.10', 'files')})
        self.assertIn(('files.bulock', '10.0.0.10'), rewrites)

    def test_merges_target_aliases_and_allows_idempotent_resolver_retry(self):
        result = move_records(self.records, 'server', '10.0.0.10', '10.0.0.20')
        self.assertEqual(result['records'][0]['names'], ['server', 'files', 'other'])
        self.assertEqual(allowed_removed(result, result, self.request), (set(), set()))

    def test_rejects_unrelated_removal_and_incorrect_source(self):
        result = move_records(self.records, 'server', '10.0.0.10', '10.0.0.30')
        result['records'].pop(0)
        with self.assertRaises(ValueError):
            allowed_removed(self.records, result, self.request)
        with self.assertRaises(ValueError):
            move_records(self.records, 'other', '10.0.0.10', '10.0.0.30')

    def test_shared_names_require_explicit_reconciliation(self):
        self.records['records'][1]['names'].append('server.bulock')
        with self.assertRaises(ValueError):
            move_records(self.records, 'server', '10.0.0.10', '10.0.0.30')

    def test_unsupported_destinations_are_rejected(self):
        for ip in ['127.0.0.1', '169.254.1.1', '224.0.0.1', '240.0.0.1', '0.0.0.0', '::1', '10.0.0.10']:
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                move_records(self.records, 'server', '10.0.0.10', ip)

    def test_move_ledger_preserves_legacy_coverage_across_later_moves(self):
        request = {**self.request, 'id': str(uuid.uuid4())}
        ledger = append_move({'moves': []}, request, self.records)
        self.assertEqual(append_move(ledger, request, self.records), ledger)
        self.assertEqual(legacy_address('10.0.0.10', 'files', ledger), '10.0.0.30')
        revised = move_records(self.records, 'server', '10.0.0.10', '10.0.0.30')
        ledger = append_move(ledger, {**request, 'id': str(uuid.uuid4()), 'fromIp': '10.0.0.30', 'ip': '10.0.0.40'}, revised)
        self.assertEqual(legacy_address('10.0.0.10', 'files', ledger), '10.0.0.40')
        self.assertEqual(legacy_address('10.0.0.20', 'other', ledger), '10.0.0.20')

    def test_legacy_validator_accepts_only_recorded_moves_and_keeps_aliases_required(self):
        revised = move_records(self.records, 'server', '10.0.0.10', '10.0.0.30')
        ledger = append_move({'moves': []}, {**self.request, 'id': str(uuid.uuid4())}, self.records)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'hosts').write_text('10.0.0.10 server files\n10.0.0.20 other\n')
            (root/'records.json').write_text(json.dumps(revised))
            (root/'moves.json').write_text(json.dumps(ledger))
            command = [sys.executable, str(Path(__file__).with_name('validate_legacy_records.py')), '--hosts-file', str(root/'hosts'),
                       '--records-file', str(root/'records.json'), '--zone', 'bulock', '--moves-file', str(root/'moves.json')]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertNotEqual(subprocess.run(command+['--ignore-address-moves'], capture_output=True).returncode, 0)
            revised['records'][1]['names'].remove('files')
            (root/'records.json').write_text(json.dumps(revised))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_controller_commits_move_ledger_and_accepts_a_later_hostname_edit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo = root/'repo'
            repo.mkdir()
            git = lambda *args: subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'DNS Test')
            git('config', 'user.email', 'test@localhost')
            (repo/'config').mkdir()
            (repo/'scripts').mkdir()
            (repo/'config/local-records.json').write_text(json.dumps(self.records))
            (repo/'config/legacy-dnsmasq.hosts').write_text('10.0.0.10 server files\n10.0.0.20 other\n')
            for name in ['validate_legacy_records.py', 'move_records.py', 'render_adguard_config.py', 'import_legacy_hosts.py']:
                shutil.copy2(Path(__file__).with_name(name), repo/'scripts'/name)
            git('add', '.')
            git('commit', '-m', 'Fixture')
            controller = Controller({'repo': str(repo), 'state': str(root/'state'), 'branch': 'main',
                                     'resolvers': [{'name': 'fixture', 'address': '192.0.2.1'}]})
            original_run = controller.run
            def run(args, **kwargs):
                if args[:2] == ['git', 'push'] or 'scripts/validate_render_rewrites.py' in args:
                    return ''
                return original_run(args, **kwargs)
            try:
                with patch.object(controller, 'refresh'), patch.object(controller, 'run', side_effect=run), patch.object(controller, 'node_request', return_value={}):
                    move_id = str(uuid.uuid4())
                    controller.request({**self.request, 'operation': 'hostname.move', 'id': move_id,
                                        'expectedRevision': controller.records()['revision']})
                    controller.deploy(move_id)
                    self.assertEqual(controller.result(move_id)['state'], 'live')
                    ledger = json.loads((repo/'config/address-moves.json').read_text())
                    self.assertEqual(ledger['moves'][0]['names'], ['server', 'files'])
                    edit_id = str(uuid.uuid4())
                    controller.request({'operation': 'hostname.set', 'id': edit_id, 'hostname': 'new-alias',
                                        'ip': '10.0.0.30', 'expectedRevision': controller.records()['revision']})
                    controller.deploy(edit_id)
                    self.assertEqual(controller.result(edit_id)['state'], 'live')
                    self.assertEqual(git('status', '--porcelain', '--untracked-files=no'), '')
            finally:
                controller.db.close()


if __name__ == '__main__':
    unittest.main()
