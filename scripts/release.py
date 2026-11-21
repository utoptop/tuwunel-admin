#!/usr/bin/env python3
"""Build/push this project, verify its manifest, then remove its local leftovers."""
import argparse
import json
import re
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = 'utoptop/tuwunel-admin'
SOURCE = 'https://github.com/utoptop/tuwunel-admin'


def run(*args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def image_ids(ref):
    return set(run('docker', 'image', 'ls', '-aq', '--no-trunc', '--filter', ref, capture=True).split())


def removable(image, protected):
    tags = image.get('RepoTags') or []
    labels = image.get('Config', {}).get('Labels') or {}
    return (image['Id'] not in protected
            and labels.get('org.opencontainers.image.source') == SOURCE
            and all(tag.startswith(IMAGE + ':') for tag in tags))


def cleanup(version, legacy_builder=None, dry_run=False):
    protected = image_ids('reference=' + IMAGE + ':1.0') | image_ids('reference=' + IMAGE + ':' + version)
    containers = run('docker', 'ps', '-aq', capture=True).split()
    if containers:
        protected |= {c['Image'] for c in json.loads(run('docker', 'inspect', *containers, capture=True))}
    candidates = image_ids('label=org.opencontainers.image.source=' + SOURCE)
    if candidates:
        for image in json.loads(run('docker', 'image', 'inspect', *sorted(candidates), capture=True)):
            if not removable(image, protected):
                print('Keep image:', image['Id'][:19], image.get('RepoTags'), flush=True)
                continue
            refs = image.get('RepoTags') or [image['Id']]
            print('Remove project image:', ', '.join(refs), flush=True)
            if not dry_run:
                # No --force: Docker retains any image that acquires a container reference.
                run('docker', 'image', 'rm', *refs)
    if legacy_builder:
        print('Remove identifiable legacy cache only:', legacy_builder, flush=True)
        if not dry_run:
            run('docker', 'buildx', 'prune', '--builder', legacy_builder, '--force',
                '--filter', 'description~=tuwunel-admin', '--filter', 'inuse=false')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='1.5')
    parser.add_argument('--cleanup-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--legacy-builder', help='Only prune cache explicitly mentioning tuwunel-admin in this shared builder')
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', args.version):
        parser.error('version must be numeric major.minor[.patch]')
    if args.cleanup_only or args.dry_run:
        cleanup(args.version, args.legacy_builder, args.dry_run)
        return
    builder = 'tuwunel-admin-release-' + uuid.uuid4().hex[:8]
    run('docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container')
    try:
        run('docker', 'buildx', 'build', '--builder', builder, '--platform', 'linux/amd64,linux/arm64',
            '--tag', IMAGE + ':1.0', '--tag', IMAGE + ':' + args.version, '--push', '.')
        run('docker', 'buildx', 'imagetools', 'inspect', IMAGE + ':' + args.version)
        run('docker', 'pull', IMAGE + ':' + args.version)
        run('docker', 'pull', IMAGE + ':1.0')
        cleanup(args.version, args.legacy_builder)
    finally:
        # This randomly named builder belongs exclusively to this invocation.
        # Removing it (without --keep-state) also deletes its BuildKit cache volume.
        run('docker', 'buildx', 'rm', builder)


if __name__ == '__main__':
    main()
