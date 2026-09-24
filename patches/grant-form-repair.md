# Deterministic repair for the grant form filler

This patch belongs on [agentic-grant-form-filler](https://github.com/gobrando/agentic-grant-form-filler) at `b5d84a0`. It could not be pushed there: GitHub denied `cursor[bot]` write access. The commit on the machine that produced it is `70156c8`.

Apply it from a checkout of that revision:

```bash
git checkout b5d84a0
git apply patches/grant-form-repair.patch
python3 -m unittest discover -s tests -v
```

The repair extends the demo playbook's field map and returns a proposal. It does not rewrite the playbook, call a model, or submit the form. EIN, SSN, bank account, and award amount move only when the label clearly names them. They do not land on project id, case number, or reference number. A tie or a dropped field blocks the whole proposal. An observation that includes a value is rejected.
