#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from import_legacy_hosts import parse_hosts
from render_adguard_config import render_rewrites
from move_records import legacy_address


def load_records(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify local-record coverage for the legacy dns-config hosts inventory"
    )
    parser.add_argument("--hosts-file", required=True, type=Path)
    parser.add_argument("--records-file", required=True, type=Path)
    parser.add_argument("--zone", required=True)
    parser.add_argument('--moves-file', type=Path)
    parser.add_argument('--ignore-address-moves', action='store_true')
    args = parser.parse_args()
    retired_path = Path(__file__).resolve().parents[1] / 'config/retired-legacy-records.json'
    retired = {tuple(mapping) for mapping in json.loads(retired_path.read_text())['mappings']} if retired_path.exists() else set()

    legacy_records = parse_hosts(args.hosts_file)
    local_records = load_records(args.records_file)
    moves_path = args.moves_file or Path(__file__).resolve().parents[1] / 'config/address-moves.json'
    ledger = load_records(moves_path) if not args.ignore_address_moves and moves_path.exists() else {'moves': []}

    raw_mappings = {
        (record["value"], name)
        for record in local_records["records"]
        for name in record["names"]
    }
    rendered_mappings = {
        (rewrite["answer"], rewrite["domain"])
        for rewrite in render_rewrites(local_records)
    }

    missing_raw: list[str] = []
    missing_rendered: list[str] = []
    bad_expansions: list[str] = []

    for ip_address, names in legacy_records.items():
        for name in names:
            if (ip_address, name) in retired:
                continue
            expected_ip = legacy_address(ip_address, name, ledger)
            if (expected_ip, name) not in raw_mappings:
                missing_raw.append(f"{expected_ip} {name}")
            expected_domains = [name] if "." in name else [name, f"{name}.{args.zone}"]
            for expected_domain in expected_domains:
                if (expected_ip, expected_domain) not in rendered_mappings:
                    missing_rendered.append(f"{expected_ip} {expected_domain}")
            if "." in name:
                expanded_domain = f"{name}.{args.zone}"
                if (expected_ip, expanded_domain) in rendered_mappings:
                    bad_expansions.append(f"{expected_ip} {expanded_domain}")

    errors: list[str] = []
    if missing_raw:
        errors.append("missing local-record entries:\n- " + "\n- ".join(missing_raw))
    if missing_rendered:
        errors.append("missing rendered rewrite entries:\n- " + "\n- ".join(missing_rendered))
    if bad_expansions:
        errors.append(
            "dotted names were incorrectly expanded into the local zone:\n- "
            + "\n- ".join(bad_expansions)
        )

    if errors:
        raise SystemExit("\n\n".join(errors))

    print(
        "validated "
        f"{sum(len(names) for names in legacy_records.values())} legacy host mappings "
        f"from {args.hosts_file}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
