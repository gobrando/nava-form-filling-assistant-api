# Form-filling profile for the transcript scribe

This patch belongs on [scribe](https://github.com/gobrando/scribe) at `8f2fd62`. It could not be pushed there: GitHub denied `cursor[bot]` write access. The commit on the machine that produced it is `9a3227d`.

Apply it from a checkout of that revision:

```bash
git checkout 8f2fd62
git apply patches/scribe-form-run.patch
python3 scribe/test_scribe.py
```

The profile records a form-filling run as counts and refusal reasons. A warm repair confirms the script path and field counts. A refusal confirms the rule (`ssn must not become case number`) and does not confirm a guess. A line that carries a household value is not stored. An agent claiming it submitted the form is recorded as a human submission, not as the tool having submitted.
