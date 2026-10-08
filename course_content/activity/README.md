# JupyterLab course milestones

Opt-in JavaScript extension using the DLI Activity SDK. Opening a configured
notebook starts an anonymous session. Successful execution of each tagged cell
checks off its milestone and records aggregate progress. All nine markers and
API confirmation are required for “Course complete.” No Python tracking calls.

## Local setup

Requires Python 3.12+, Node.js 22+, and access to the Activity API. Run from the
repository root. This installs JupyterLab, not the GPU course dependencies.

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

## Milestones

Each selected cell has a `dli:complete:<id>` metadata tag. The config maps tags
to notebook paths relative to the server root; optional `label` and `description`
fields supply the panel text. Missing config disables tracking.

| Notebook | Tagged cell |
|---|---|
| `00_jupyterlab` | Introductory print statement |
| `01_mnist` | `prediction.argmax(dim=1, keepdim=True)` |
| `02_asl` | Final training/validation loop |
| `03_asl_cnn` | Final training/validation loop |
| `04a_asl_augmentation` | Augmented training/validation loop |
| `04b_asl_predictions` | `predict_letter("images/A.jpg")` |
| `05a_doggy_door` | Final `doggy_door` call (sleepy cat image) |
| `05b_corgi_door` | Final `corgi_doggy_door` call (Penny image) |
| `06_nlp` | `question_answering_tokenizer.decode(answer_sequence)` |

Repeated executions, errors, empty cells, and saved outputs do not count.
Progress is `floor(100 × distinct executed markers / 9)`, independent of order.
The API stores aggregate progress, not individual marker IDs. Failed requests
can be retried with the panel’s **Retry** button; logical writes reuse their keys.

Progress and tokens stay in browser memory. Kernel restarts preserve progress;
reloading or opening another tab starts a new session. These milestones measure
execution, not answer correctness or independent knowledge: learners can edit
cells or use the supplied solutions. The digit-label comparison is an instruction,
not an automatic check. Notebook 00 is orientation, not an assessment.

## Tests

Run `npm test` from `course_content/activity` for tracking and marker checks.
`test/browser.mjs` tests the installed extension with real Python kernels,
temporary lightweight notebooks, and a mocked Activity API. It covers failed
and repeated executions, kernel restart, all-nine gating, and API retry without
training course models or writing API records.

Install Google Chrome and run JupyterLab with
`--LabApp.expose_app_in_browser=True`. Save the authenticated login URL to a
private file outside the repository, then run from `course_content/activity`:

```sh
AUTH_URL_FILE=/absolute/path/to/private-login-url node test/browser.mjs
```

## SDK

`src/activity-sdk.js` is the unmodified Apache-2.0 NVIDIA `DLIActivity` browser
facade snapshot (SHA-256
`e80ca6f2a4d14ef66c52de38e5d8c765a348a5860fec72e61a606ac254880632`).
It is vendored until a versioned SDK distribution exists. Nothing is published
to npm/PyPI and the Docker/Brev launch is unchanged.
