# JupyterLab activity pilot

This opt-in prototype records a course start when a configured notebook opens,
then records progress as the learner successfully executes marked cells. All
nine notebook markers are required for automatic completion. The panel displays
progress; it has no completion button. Only cell metadata is added to the
notebooks. The normal Docker/Brev launch is unchanged.

The prototype is a prebuilt JavaScript JupyterLab extension. It uses the
`DLIActivity` facade; no Python tracking helper or Python tracking calls are
needed. Markers use notebook cell metadata tags. Nothing is published to npm
or PyPI by this prototype.

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
3. Run its tagged print cell. The **Progress** panel shows 1 of 9 and 11%.
4. Run the tagged cells in the other notebooks successfully. Repeats, execution
   errors, empty cells, unmarked cells, and saved outputs do not add progress.
5. After all nine markers execute, the extension sends 100%, then completion,
   and verifies the resulting state. The final NLP marker alone cannot complete.
6. If a request fails, keep using the course and click **Retry** when connected.
   Evidence stays in browser memory and retries reuse semantic idempotency keys.

## Course markers

Each selected code cell has `metadata.tags: ["dli:complete:<id>"]`. The config
maps each tag to its notebook path. `NotebookActions.executed` supplies the
success flag and executed cell; the extension checks the owning notebook,
code-cell type, and a real execution count. It does not scan historical outputs.

| Notebook | Tagged cell |
|---|---|
| `00_jupyterlab` | Introductory print statement |
| `01_mnist` | `prediction.argmax(dim=1, keepdim=True)` |
| `02_asl` | Final training/validation loop |
| `03_asl_cnn` | Final training/validation loop |
| `04a_asl_augmentation` | `torch.save(base_model, 'model.pth')` |
| `04b_asl_predictions` | `predict_letter("images/A.jpg")` |
| `05a_doggy_door` | Final `doggy_door` call (sleepy cat image) |
| `05b_corgi_door` | Final `corgi_doggy_door` call (Penny image) |
| `06_nlp` | `question_answering_tokenizer.decode(answer_sequence)` |

Progress is `floor(100 × distinct executed markers / 9)`: 11, 22, 33, 44, 55,
66, 77, 88, 100. Notebook order does not matter. Each marker counts once in the
browser session, including across kernel restarts. All nine are necessary,
including both parts of modules 4 and 5. Kernel-reset cells are never markers.

## Scope and limitations

- One anonymous Activity session per browser tab. Kernel restarts do not reset
  the browser tracker. A page reload or another tab starts another session;
  start counts are therefore sessions, not unique learners.
- Activity tokens and the marker ledger remain in memory. Reloading loses the
  ledger; rerun the markers to establish progress in the new session. No browser-
  storage persistence and no restoration from notebook execution counts.
- Completion means all configured marker cells executed successfully. It does
  not establish that every cell ran, outputs were correct, or the learner passed
  an assessment. Learners can edit notebooks. This is execution telemetry, not
  certification. The API stores aggregate progress, not individual marker IDs.
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

`npm test` covers marker placement, scoping, valid executions, deduplication,
all-nine gating, concurrency, session reuse, API failures, session replacement,
retry, and state confirmation.

`test/browser.mjs` exercises the installed extension in a running JupyterLab
using Chrome and temporary lightweight notebook fixtures with real Python
kernels. It executes the NLP marker first, tests failures, empty cells, reruns,
a kernel restart, all-nine gating, and an API outage. It defaults to intercepting
Activity requests. The final fixture uses the exact decode expression with a
fake tokenizer; this tests event wiring, not BERT or the course exercises. Its optional live mode writes **real test records** to the configured
API. Use a development test artifact. It never prints session tokens. The test
intercepts only its own configuration read to select temporary fixture paths;
real course notebooks are not edited by the test. Run the server with
`--LabApp.expose_app_in_browser=True` for this browser automation.

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
