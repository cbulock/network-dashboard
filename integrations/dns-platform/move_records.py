"""Explicit, revision-guarded movement of an entire address record and its aliases."""
import copy
import ipaddress
import uuid
from render_adguard_config import render_rewrites, rendered_domains


def append_move(ledger, request, document):
    result = copy.deepcopy(ledger)
    source = next(r for r in document['records'] if r['value'] == request['fromIp'])
    entry = {'id': str(uuid.UUID(request['id'])), 'fromIp': request['fromIp'],
             'ip': request['ip'], 'names': source['names'][:]}
    existing = next((m for m in result['moves'] if m['id'] == entry['id']), None)
    if existing and existing != entry:
        raise ValueError('Address move request ID already has different content')
    if not existing:
        result['moves'].append(entry)
    return result


def legacy_address(address, name, ledger):
    if not isinstance(ledger, dict) or not isinstance(ledger.get('moves'), list):
        raise ValueError('Invalid address move ledger')
    for move in ledger['moves']:
        uuid.UUID(move['id'])
        old, new = str(ipaddress.IPv4Address(move['fromIp'])), str(ipaddress.IPv4Address(move['ip']))
        if not isinstance(move['names'], list) or not move['names'] or not all(isinstance(n, str) and n for n in move['names']):
            raise ValueError('Invalid address move names')
        if address == old and name in move['names']:
            address = new
    return address


def move_records(document, name, old_ip, new_ip):
    old_ip, new_ip = str(ipaddress.IPv4Address(old_ip)), str(ipaddress.IPv4Address(new_ip))
    address = ipaddress.IPv4Address(new_ip)
    if old_ip == new_ip or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified or int(address) >= int(ipaddress.IPv4Address('240.0.0.0')):
        raise ValueError('Select a different device IPv4 address')
    result = copy.deepcopy(document)
    source = next((r for r in result['records'] if r['value'] == old_ip), None)
    if not source or name not in source['names']:
        raise ValueError('The original managed hostname/address changed')
    domains = {d.lower() for n in source['names'] for d in rendered_domains(n, result['zone'])}
    for record in result['records']:
        if record is source:
            continue
        other = {d.lower() for n in record['names'] for d in rendered_domains(n, result['zone'])}
        if domains & other:
            raise ValueError('Shared DNS names require manual reconciliation')
    target = next((r for r in result['records'] if r['value'] == new_ip), None)
    if target is None:
        target = {'type': 'A', 'value': new_ip, 'names': []}
        result['records'].append(target)
    target['names'] = list(dict.fromkeys(source['names'] + target['names']))
    result['records'].remove(source)
    render_rewrites(result)
    return result


def allowed_removed(current, desired, move):
    if not move:
        return set(), set()
    # A retry may reach a resolver that already applied this exact candidate.
    if current == desired:
        return set(), set()
    revised = move_records(current, move['hostname'], move['fromIp'], move['ip'])
    pairs = lambda doc: {(r['value'], n.lower()) for r in doc['records'] for n in r['names']}
    if current['zone'] != desired['zone'] or pairs(revised) != pairs(desired):
        raise ValueError('Candidate is not the exact authorized DNS address move')
    removed = pairs(current) - pairs(desired)
    rewrites = {(d, ip) for ip, n in removed for d in rendered_domains(n, current['zone'])}
    return removed, rewrites
