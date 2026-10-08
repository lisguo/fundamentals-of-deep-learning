# JupyterLab activity pilot

This opt-in prototype records a course start when a configured notebook opens,
then lets the learner report completion using a button in JupyterLab. Completion
is **self-reported**, not exercise verification or certification. The notebooks
and the normal Docker/Brev launch are unchanged.

The prototype is a prebuilt JavaScript JupyterLab extension. It uses the
`DLIActivity` facade; no Python tracking helper or notebook modifications are
needed. Nothing is published to npm or PyPI by this prototype.

## Local setup

Requirements: Python 3.12+, Node.js 22+, npm, and access to the chosen Activity
API environment (including VPN if required). These commands run from the
repository root. The minimal environment can open notebooks and test tracking;
it does not install PyTorch, datasets, or the full GPU course environment.

```sh
python3 -m venv .venv-activity
. .venv-activity/bin/activate
python -m pip install jupyterlab==4.6.4
cd course_content/activity
npm ci
npm test
npm run build
cd ../..
```

Install the built extension into this virtual environment:

```sh
python - <<'PY'
import shutil
import sys
from pathlib import Path
source = Path('course_content/activity/labextension')
target = Path(sys.prefix) / 'share/jupyter/labextensions/@dli/fdl-activity-pilot'
shutil.copytree(source, target, dirs_exist_ok=True)
PY
jupyter labextension list
```

Copy `activity-config.example.json` to
`course_content/activity-config.local.json`. Replace the API and artifact
placeholders with release-provided values. This local configuration is ignored
by Git. It contains no bearer token. The API must accept the actual browser
origin, including its port. Register the FDL release for a real integration;
a shared development sample identity is only a connectivity experiment, not an
FDL registration.

```sh
cp course_content/activity/activity-config.example.json course_content/activity-config.local.json
jupyter lab --ServerApp.root_dir="$PWD/course_content" --ip=127.0.0.1 --port=3000 --ServerApp.port_retries=0 --no-browser
```

Open the authenticated Jupyter URL printed by the server using `localhost` as
the hostname if that is the registered origin. Leave Jupyter authentication
enabled. Its login token is separate from the Activity SDK token.

1. The launcher alone does not start tracking.
2. Open `tutorials/00_jupyterlab.ipynb` (or another configured notebook).
3. The **Course activity** panel reports a started session and its public ID.
4. Click **Mark course complete** to report completion. The extension sends
   100% progress, then completion, and verifies the resulting server state.
5. If a request fails, keep using the course and click **Retry** when connected.
   Retried writes use the same semantic idempotency keys.

## Scope and limitations

- One anonymous Activity session per browser tab. Kernel restarts do not reset
  the browser tracker. A page reload or another tab starts another session;
  start counts are therefore sessions, not unique learners.
- Activity tokens remain in SDK-managed memory. No browser-storage persistence.
- No automatic completion, assessments, grades, checkpoint tracking, or changes
  to the API contract. The API's completion record has no evidence-type field;
  report this pilot's completion metrics as self-reported.
- Only exact notebook paths in the local config trigger tracking. Paths are
  relative to the Jupyter server root. Missing config disables the extension.
- No automatic background retries: the UI exposes a retry button. A request
  timeout is not confirmation of a failed write; retry uses the original key.
- API connectivity and CORS must work from the learner's browser. A successful
  command-line request alone does not establish that.
- This prototype is colocated in the FDL fork for local testing. Extract the
  extension into the proposed private `dli-activity-sdk` project before sharing
  it across courses. Do not publish this package as an official SDK release.

## Tests

`npm test` covers notebook scoping, configuration validation, session reuse,
completion ordering, duplicate clicks, API failure, retry, and state confirmation.

`test/browser.mjs` exercises the installed extension in a running JupyterLab
using Chrome. It defaults to intercepting Activity requests and simulating an
outage. Its optional live mode writes **real test records** to the configured
API. Use a development test artifact. It never prints session tokens.

```sh
# Save the authenticated local Jupyter URL in a private file outside this repo.
AUTH_URL_FILE=/absolute/path/to/private-login-url node test/browser.mjs
# Explicitly opt in to real API writes:
LIVE_ACTIVITY=1 AUTH_URL_FILE=/absolute/path/to/private-login-url node test/browser.mjs
```

Do not run live mode against production. Test records are retained as evidence;
the runner does not delete them. Browser tests verify API responses, not SQL
persistence independently. Install Google Chrome before running them.

## SDK provenance

`src/activity-sdk.js` is an unmodified snapshot of the NVIDIA-authored,
Apache-2.0 `DLIActivity` browser facade supplied with the existing course
integration. SHA-256:
`e80ca6f2a4d14ef66c52de38e5d8c765a348a5860fec72e61a606ac254880632`.
It is vendored solely for this pilot until a versioned SDK distribution exists.
