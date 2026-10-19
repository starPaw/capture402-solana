"""Shared fail-closed release eligibility; no deployment or economic side effects."""
import datetime
import re
import deployment_config

REPOSITORY = 'starPaw/capture402-solana'
REQUIRED_JOBS = {'SBF build and component checks', 'x402 integration, typecheck and wallet build'}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def verified_repository(api):
    identifier = deployment_config.require_repository()
    item = api('repositories/' + str(identifier))
    require(isinstance(item, dict) and type(item.get('id')) is int and item['id'] == identifier
            and item.get('full_name') == REPOSITORY and item.get('private') is False,
            'public source repository ID/name/visibility mismatch')


def verified_ci(sha, api, branch, legacy_event, pull_number=None):
    """Accept explicit critical CI, retaining exact-source historical evidence."""
    root = 'repos/' + REPOSITORY
    runs = api(root + '/actions/workflows/components.yml/runs?head_sha=' + sha + '&per_page=1')['workflow_runs']
    require(len(runs) == 1, 'exact-source CI missing')
    run = runs[0]
    if run['event'] == 'workflow_dispatch':
        source_matches = run.get('head_branch') == branch
    else:
        source_matches = run['event'] == legacy_event and (
            pull_number is None or any(p['number'] == pull_number
                                       for p in run.get('pull_requests', [])))
    require(run['head_sha'] == sha and run['status'] == 'completed'
            and run['conclusion'] == 'success' and source_matches,
            'exact-source CI has not succeeded for this branch/PR')
    jobs = api(root + f"/actions/runs/{run['id']}/jobs?per_page=100")
    require(jobs['total_count'] == len(jobs['jobs']), 'incomplete CI jobs response')
    for name in REQUIRED_JOBS:
        matches = [j for j in jobs['jobs'] if j['name'] == name]
        require(len(matches) == 1 and matches[0]['status'] == 'completed'
                and matches[0]['conclusion'] == 'success', 'required CI job failed, skipped or ambiguous')
    return run


def verify(sha, api):
    verified_repository(api)
    require(bool(re.fullmatch('[0-9a-f]{40}', sha)), 'exact lowercase SHA required')
    root = 'repos/' + REPOSITORY
    main = lambda: api(root + '/git/ref/heads/main')['object']['sha']
    require(main() == sha, 'revision is not current main')
    run = verified_ci(sha, api, 'main', 'push')
    def pages(route):
        output = []
        for page in range(1, 101):
            batch = api(root + route + f'?per_page=100&page={page}')
            require(isinstance(batch, list), 'invalid paginated response')
            output.extend(batch)
            if len(batch) < 100:
                return output
        raise RuntimeError('release metadata exceeds pagination bound')
    pulls = pages('/commits/' + sha + '/pulls')
    matched = [p for p in pulls if p.get('merged_at') and p.get('merge_commit_sha') == sha
               and p['base']['ref'] == 'main']
    require(len(matched) == 1, 'main revision lacks an unambiguous merged PR')
    pull = matched[0]
    latest = {}
    for review in pages(f"/pulls/{pull['number']}/reviews"):
        user = review['user']
        if user.get('type') == 'User' and user['login'] != 'starPaw' and review['state'] in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            latest[user['login']] = review
    accepted = [r for r in latest.values() if r['state'] == 'APPROVED' and r['commit_id'] == pull['head']['sha']]
    require(bool(accepted), 'eligible exact-head reviewer approval missing')
    tree = api(root + '/git/commits/' + sha)['tree']['sha']
    require(tree == api(root + '/git/commits/' + pull['head']['sha'])['tree']['sha'],
            'merged tree differs from reviewed head')
    require(main() == sha, 'main changed during release verification')
    return {'sha': sha, 'tree': tree, 'pull': pull['number'], 'reviewedHead': pull['head']['sha'],
            'reviewer': accepted[0]['user']['login'], 'reviewId': accepted[0]['id'],
            'ciRun': run['id'], 'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def verify_dev(sha, api):
    """Dev heads require exact tested/reviewed source; main retains its existing gate."""
    verified_repository(api)
    require(bool(re.fullmatch('[0-9a-f]{40}', sha)), 'exact lowercase SHA required')
    root = 'repos/' + REPOSITORY
    main = api(root + '/git/ref/heads/main')['object']['sha']
    if sha == main:
        return {**verify(sha, api), 'branch': 'main'}

    def pages(route):
        output = []
        for page in range(1, 101):
            batch = api(root + route + f'?per_page=100&page={page}')
            require(isinstance(batch, list), 'invalid paginated response')
            output.extend(batch)
            if len(batch) < 100:
                return output
        raise RuntimeError('dev metadata exceeds pagination bound')

    pulls = pages('/commits/' + sha + '/pulls')
    matched = [p for p in pulls if p.get('state') == 'open' and p['head']['sha'] == sha
               and p['base']['ref'] == 'main'
               and p['head'].get('repo', {}).get('full_name') == REPOSITORY
               and p['base'].get('repo', {}).get('full_name') == REPOSITORY]
    require(len(matched) == 1, 'dev revision requires one same-repository open main PR')
    pull = api(root + f"/pulls/{matched[0]['number']}")
    require(pull['state'] == 'open' and pull['head']['sha'] == sha
            and pull['base']['sha'] == main, 'dev PR or base changed')
    branch = pull['head']['ref']
    require(bool(re.fullmatch(r'[A-Za-z0-9_./-]+', branch)) and not branch.startswith('-')
            and '..' not in branch, 'invalid development branch')
    from urllib.parse import quote
    ref = root + '/git/ref/heads/' + quote(branch, safe='')
    require(api(ref)['object']['sha'] == sha, 'development branch moved')
    comparison = api(root + '/compare/' + main + '...' + sha)
    require(comparison['status'] in ('ahead', 'identical') and comparison['behind_by'] == 0,
            'dev branch must contain current main')
    run = verified_ci(sha, api, branch, 'pull_request', pull['number'])
    latest = {}
    for review in pages(f"/pulls/{pull['number']}/reviews"):
        user = review['user']
        if user.get('type') == 'User' and user['login'] != 'starPaw' and review['state'] in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            latest[user['login']] = review
    approved = [r for r in latest.values() if r['state'] == 'APPROVED' and r['commit_id'] == sha]
    require(approved and not any(r['state'] == 'CHANGES_REQUESTED' for r in latest.values()), 'eligible exact-head dev approval missing or changes requested')
    tree = api(root + '/git/commits/' + sha)['tree']['sha']
    require(pull.get('mergeable') is True and pull.get('merge_commit_sha')
            and api(root + '/git/commits/' + pull['merge_commit_sha'])['tree']['sha'] == tree,
            'tested PR merge tree differs from dev head')
    require(api(ref)['object']['sha'] == sha and api(root + '/git/ref/heads/main')['object']['sha'] == main,
            'dev source moved during verification')
    return {'sha': sha, 'tree': tree, 'branch': branch, 'pull': pull['number'],
            'reviewedHead': sha, 'reviewer': approved[0]['user']['login'], 'reviewId': approved[0]['id'],
            'ciRun': run['id'], 'main': main,
            'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
