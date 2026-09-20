#!/usr/bin/env python3
"""Submission readiness gate. Exit 0 only when every check passes.

  python3 scripts/preflight.py                      # the repo checks
  python3 scripts/preflight.py --also <file> ...    # also scan extra files (outside the repo) for placeholders
  python3 scripts/preflight.py --bytecode           # additionally prove the on-chain runtime code == forge build + immutable

Checks: the deploy record names the production contract · README test counts equal what `forge test` and `npm test`
report right now · proof/results.json exists with n >= 25 and both invariants passing · no placeholders in README /
DEMO / ARCHITECTURE (and --also files) · no tracked file references private material · no key material · live URL and
contract address present in the README · every hash cited in DEMO.md has a committed receipt.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
args = sys.argv[1:]
also = [args[i + 1] for i, a in enumerate(args) if a == '--also' and i + 1 < len(args)]
want_bytecode = '--bytecode' in args
fails, notes = [], []


def fail(m):
    fails.append(m)


def ok(m):
    notes.append(m)


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


# 1. deploy record
try:
    d = json.load(open('deploy/arc-mainnet.json'))
    addr = d['contract']['address']
    assert re.fullmatch(r'0x[0-9a-fA-F]{40}', addr) and d['chainId'] == 5042 and d['contract']['overhead'] > 0
    ok(f"deploy record: {addr} on 5042, OVERHEAD {d['contract']['overhead']}")
except Exception as e:
    fail(f'deploy/arc-mainnet.json unusable: {e}')
    d, addr = {}, ''

# 2. test counts vs README
readme = open('README.md', encoding='utf8').read() if os.path.exists('README.md') else ''
if not readme:
    fail('README.md missing')
m = re.search(r'(\d+)\s+Foundry', readme)
n_forge_readme = int(m.group(1)) if m else None
m = re.search(r'(\d+)\s+vitest', readme)
n_vitest_readme = int(m.group(1)) if m else None
r = sh(['forge', 'test', '--json'])
n_forge = None
if r.returncode == 0:
    try:
        j = json.loads(r.stdout)
        # forge >= 1.8 folds an invariant suite into ONE entry carrying
        # invariant_predicate_results (one per invariant_* function); older
        # forge lists each invariant as its own entry. Count predicates when
        # present so the total is the same on both.
        n_forge, failed = 0, []
        for s in j.values():
            for t, v in s['test_results'].items():
                preds = v.get('invariant_predicate_results') or []
                if preds:
                    n_forge += len(preds)
                    failed += [q['name'] for q in preds if q['status'] != 'Success']
                else:
                    n_forge += 1
                    if v['status'] != 'Success':
                        failed.append(t)
        if failed:
            fail(f'forge test failures: {failed}')
    except Exception as e:
        fail(f'forge test --json unparsable: {e}')
else:
    fail('forge test failed: ' + r.stderr[-300:])
r = sh(['npx', 'vitest', 'run', '--reporter=json'])
n_vitest = None
try:
    j = json.loads(r.stdout[r.stdout.index('{'):])
    n_vitest = j['numTotalTests']
    if j['numFailedTests']:
        fail(f"vitest failures: {j['numFailedTests']}")
except Exception as e:
    fail(f'vitest json unparsable: {e}')
if n_forge is not None and n_forge_readme != n_forge:
    fail(f'README says {n_forge_readme} Foundry tests, forge test reports {n_forge}')
elif n_forge is not None:
    ok(f'Foundry tests: {n_forge} (README agrees)')
if n_vitest is not None and n_vitest_readme != n_vitest:
    fail(f'README says {n_vitest_readme} vitest tests, vitest reports {n_vitest}')
elif n_vitest is not None:
    ok(f'vitest tests: {n_vitest} (README agrees)')

# 3. bench results
try:
    res = json.load(open('proof/results.json'))
    assert res['n'] >= 25, f"n = {res['n']} < 25"
    assert res['drift']['pass'] and res['ratio']['pass'], 'a bench invariant failed'
    assert os.path.exists('proof/rows.csv')
    rows = open('proof/rows.csv').read().strip().splitlines()
    assert len(rows) - 1 == res['n'], 'rows.csv length != results.n'
    ok(f"bench: n {res['n']}, gasUsed p50 {res['gasUsed']['p50']} p95 {res['gasUsed']['p95']}, drift |max| {res['drift']['absMax']}, ratio p50 {res['ratio']['p50']}")
except Exception as e:
    fail(f'proof/results.json: {e}')

# 4. placeholders
PLACEHOLDER = re.compile(r'TODO|FIXME|XXX|TBD|\[filled on|0x…|0x\.\.\.|<address>|<hash>|lorem ipsum', re.I)
for f in ['README.md', 'DEMO.md', 'ARCHITECTURE.md'] + also:
    if not os.path.exists(f):
        fail(f'{f} missing')
        continue
    for i, line in enumerate(open(f, encoding='utf8'), 1):
        if PLACEHOLDER.search(line):
            fail(f'placeholder in {f}:{i}: {line.strip()[:100]}')
ok('no placeholders')

# 5. private material / key material in tracked files
tracked = sh(['git', 'ls-files']).stdout.split()
PRIVATE = re.compile(r'(^|/)(specs|_specs|_ideas|assets/ui)/|probes\.md|scores\.md|qa-log|predictions|CLAUDE\.md|AGENTS\.md|\.claude/|build-log', re.I)
KEYISH = re.compile(r'PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}|mnemonic|seed phrase|"ciphertext"|BEGIN (RSA|EC|OPENSSH) PRIVATE', re.I)
for f in tracked:
    if f.startswith('lib/') or f == 'scripts/preflight.py':  # the patterns themselves live here
        continue
    if PRIVATE.search(f):
        fail(f'private path tracked: {f}')
    try:
        txt = open(f, encoding='utf8', errors='ignore').read()
    except Exception:
        continue
    if f.endswith(('.md', '.ts', '.sol', '.json', '.py', '.html', '.css', '.toml', '.example')):
        for mm in PRIVATE.finditer(txt):
            fail(f'private reference in {f}: {mm.group(0)}')
            break
        if KEYISH.search(txt):
            fail(f'key-shaped material in {f}')
ok('no private paths or key material in tracked files')

# 6. README essentials
if addr and addr.lower() not in readme.lower():
    fail('README does not name the production contract address')
if 'https://legwork.edycu.dev/' not in readme:
    fail('README lacks the live URL')
ok('README names the contract and the live URL')

# 7. every hash in DEMO.md has a receipt
if os.path.exists('DEMO.md'):
    demo = open('DEMO.md', encoding='utf8').read()
    hashes = set(re.findall(r'0x[0-9a-fA-F]{64}', demo))
    receipts = set(f[:-5] for f in os.listdir('proof/receipts')) | set(f[:-5] for f in os.listdir('proof/gasmeter-2026-09-17') if f.endswith('.json'))
    missing = [h for h in hashes if h not in receipts and h.lower() not in {x.lower() for x in receipts}]
    if missing:
        fail(f'DEMO.md cites {len(missing)} hash(es) without a committed receipt: {missing[:3]}')
    else:
        ok(f'DEMO.md: {len(hashes)} transaction hashes, all with committed receipts')

# 8. optional: bytecode identity
if want_bytecode and addr:
    r = sh(['forge', 'build', '--silent'])
    try:
        art = json.load(open('out/Legwork.sol/Legwork.json'))
        code = bytearray.fromhex(art['deployedBytecode']['object'][2:])
        for refs in art['deployedBytecode']['immutableReferences'].values():
            for ref in refs:
                code[ref['start']:ref['start'] + ref['length']] = int(d['contract']['overhead']).to_bytes(32, 'big')
        onchain = sh(['cast', 'code', addr, '--rpc-url', d['rpc']]).stdout.strip()[2:]
        if onchain.lower() == code.hex().lower():
            ok(f'bytecode: on-chain runtime code at {addr} == forge build with OVERHEAD={d["contract"]["overhead"]} ({len(code)} bytes)')
        else:
            fail('bytecode mismatch between the chain and this source')
    except Exception as e:
        fail(f'bytecode check failed: {e}')

for n in notes:
    print('ok   ', n)
for f in fails:
    print('FAIL ', f)
print(f'\n{len(notes)} ok · {len(fails)} failed')
sys.exit(1 if fails else 0)
